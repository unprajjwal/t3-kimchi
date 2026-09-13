import {
  type CustomModelSetting,
  type KimchiSettings,
  type ModelCapabilities,
  type ServerProvider,
  type ServerProviderAuth,
  type ServerProviderModel,
} from "@t3tools/contracts";
import { causeErrorTag } from "@t3tools/shared/observability";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import { HttpClient } from "effect/unstable/http";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { createModelCapabilities } from "@t3tools/shared/model";
import { resolveSpawnCommand } from "@t3tools/shared/shell";

import {
  buildServerProvider,
  isCommandMissingCause,
  parseGenericCliVersion,
  providerModelsFromSettings,
  spawnAndCollect,
  type ServerProviderDraft,
} from "../providerSnapshot.ts";
import {
  enrichProviderSnapshotWithVersionAdvisory,
  type ProviderMaintenanceCapabilities,
} from "../providerMaintenance.ts";

const KIMCHI_PRESENTATION = {
  displayName: "Kimchi",
  supportsConversationRollback: false,
  badgeLabel: "Early Access",
  showInteractionModeToggle: false,
  // Kimchi's ACP session emits an (unstable, per-spec) `usage_update`
  // notification with live `used`/`size` context-window token counts; see
  // KimchiAdapter.ts's `UsageUpdated` case.
  reportsContextWindow: true,
} as const;
const EMPTY_CAPABILITIES: ModelCapabilities = createModelCapabilities({
  optionDescriptors: [],
});

const VERSION_PROBE_TIMEOUT_MS = 4_000;
// Observed live: unlike Grok's `grok models`, Kimchi's `--list-models` makes
// a live catalog request with no local cache and can take 10+ seconds, so it
// needs more headroom than the shared `AUTH_PROBE_TIMEOUT_MS` other
// providers' faster commands use.
const LIST_MODELS_PROBE_TIMEOUT_MS = 20_000;
const KIMCHI_API_KEY_ENV = "KIMCHI_API_KEY";
// Kimchi advertises no distinct built-in default model slug (unlike Grok's
// "grok-build" product sentinel); the model list comes entirely from
// `--list-models` discovery and user-configured custom models.
const KIMCHI_BUILT_IN_MODELS: ReadonlyArray<ServerProviderModel> = [];

/**
 * `buildServerProvider` plus `supportsTextGeneration: false`, always. Kimchi's
 * `textGeneration` (see KimchiTextGeneration.ts) is a stub that fails every
 * call, so it must never be offered as a commit-message/PR/title generation
 * source in provider pickers.
 */
function buildKimchiServerProvider(
  input: Parameters<typeof buildServerProvider>[0],
): ServerProviderDraft {
  return { ...buildServerProvider(input), supportsTextGeneration: false };
}

export function buildInitialKimchiProviderSnapshot(
  kimchiSettings: KimchiSettings,
): Effect.Effect<ServerProviderDraft> {
  return Effect.gen(function* () {
    const checkedAt = yield* Effect.map(DateTime.now, DateTime.formatIso);
    const models = kimchiModelsFromSettings(kimchiSettings.customModels);

    if (!kimchiSettings.enabled) {
      return buildKimchiServerProvider({
        presentation: KIMCHI_PRESENTATION,
        enabled: false,
        checkedAt,
        models,
        probe: {
          installed: false,
          version: null,
          status: "warning",
          auth: { status: "unknown" },
          message: "Kimchi is disabled in T3 Code settings.",
        },
      });
    }

    return buildKimchiServerProvider({
      presentation: KIMCHI_PRESENTATION,
      enabled: true,
      checkedAt,
      models,
      probe: {
        installed: true,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Checking Kimchi CLI availability...",
      },
    });
  });
}

function kimchiModelsFromSettings(
  customModels: ReadonlyArray<CustomModelSetting> | undefined,
  builtInModels: ReadonlyArray<ServerProviderModel> = KIMCHI_BUILT_IN_MODELS,
): ReadonlyArray<ServerProviderModel> {
  return providerModelsFromSettings(builtInModels, customModels ?? [], EMPTY_CAPABILITIES);
}

const runKimchiCliCommand = (
  kimchiSettings: KimchiSettings,
  args: ReadonlyArray<string>,
  environment: NodeJS.ProcessEnv,
) =>
  Effect.gen(function* () {
    const command = kimchiSettings.binaryPath || "kimchi";
    const spawnCommand = yield* resolveSpawnCommand(command, args, { env: environment });
    return yield* spawnAndCollect(
      command,
      ChildProcess.make(spawnCommand.command, spawnCommand.args, {
        env: environment,
        shell: spawnCommand.shell,
      }),
    );
  });

export interface KimchiListModelsOutput {
  readonly authenticated: boolean;
  readonly models: ReadonlyArray<ServerProviderModel>;
}

/**
 * Parses `kimchi --list-models`. The flag exits 0 whether or not a provider
 * is logged in — an unauthenticated CLI prints a fixed "No models available"
 * line instead of an error, so that text is the auth signal, same role as
 * Grok's `grok models` login banner.
 *
 * The authenticated table looks like:
 *
 *     provider    model                   context  max-out  thinking  images
 *     kimchi-dev  deepseek-v4-flash-0731  1.0M     512K     yes       no
 *     kimchi-dev  glm-5.3                 1.0M     131.1K   yes       no
 *
 * Only the `provider`/`model` columns are used, joined as `provider/model` —
 * the format the CLI's own `--model <pattern>` flag documents accepting
 * ("optionally `provider/id`"). Non-table lines (a leading model-roles
 * warning, blank lines) are ignored rather than tripping the parser.
 */
export function parseKimchiListModelsOutput(output: string): KimchiListModelsOutput {
  const unauthenticated = /no models available/i.test(output);
  const lines = output.split(/\r?\n/);
  const headerIndex = lines.findIndex((line) => /^\s*provider\s+model\b/i.test(line));
  const models: ServerProviderModel[] =
    headerIndex === -1
      ? []
      : lines.slice(headerIndex + 1).flatMap((line) => {
          const columns = line.trim().split(/\s+/);
          const provider = columns[0];
          const model = columns[1];
          if (!provider || !model) {
            return [];
          }
          const slug = `${provider}/${model}`;
          return [
            {
              slug,
              name: model,
              isCustom: false,
              capabilities: EMPTY_CAPABILITIES,
            },
          ];
        });
  return {
    authenticated: !unauthenticated && output.trim().length > 0,
    models,
  };
}

export const checkKimchiProviderStatus = Effect.fn("checkKimchiProviderStatus")(function* (
  kimchiSettings: KimchiSettings,
  environment: NodeJS.ProcessEnv = process.env,
): Effect.fn.Return<ServerProviderDraft, never, ChildProcessSpawner.ChildProcessSpawner> {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const fallbackModels = kimchiModelsFromSettings(kimchiSettings.customModels);

  if (!kimchiSettings.enabled) {
    return buildKimchiServerProvider({
      presentation: KIMCHI_PRESENTATION,
      enabled: false,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Kimchi is disabled in T3 Code settings.",
      },
    });
  }

  const versionResult = yield* runKimchiCliCommand(kimchiSettings, ["version"], environment).pipe(
    Effect.timeoutOption(VERSION_PROBE_TIMEOUT_MS),
    Effect.result,
  );

  if (Result.isFailure(versionResult)) {
    const error = versionResult.failure;
    yield* Effect.logWarning("Kimchi CLI health check failed.", {
      errorTag: error._tag,
    });
    return buildKimchiServerProvider({
      presentation: KIMCHI_PRESENTATION,
      enabled: kimchiSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: !isCommandMissingCause(error),
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: isCommandMissingCause(error)
          ? "Kimchi CLI (`kimchi`) is not installed or not on PATH."
          : "Failed to execute Kimchi CLI health check.",
      },
    });
  }

  if (Option.isNone(versionResult.success)) {
    return buildKimchiServerProvider({
      presentation: KIMCHI_PRESENTATION,
      enabled: kimchiSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: "Kimchi CLI is installed but timed out while running `kimchi version`.",
      },
    });
  }

  const versionOutput = versionResult.success.value;
  const version = parseGenericCliVersion(`${versionOutput.stdout}\n${versionOutput.stderr}`);
  if (versionOutput.code !== 0) {
    yield* Effect.logWarning("Kimchi CLI version probe exited with a non-zero status.", {
      exitCode: versionOutput.code,
      stdoutLength: versionOutput.stdout.length,
      stderrLength: versionOutput.stderr.length,
    });
    return buildKimchiServerProvider({
      presentation: KIMCHI_PRESENTATION,
      enabled: kimchiSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version,
        status: "error",
        auth: { status: "unknown" },
        message: "Kimchi CLI is installed but failed to run.",
      },
    });
  }

  // A stored/env API key that is invalid makes the CLI exit non-zero on
  // essentially every invocation (it eagerly validates against Kimchi's
  // model-list endpoint at startup), so `--list-models` doubles as both the
  // model and the auth-status probe without ever calling `authenticate` or
  // opening a session.
  const listModelsResult = yield* runKimchiCliCommand(
    kimchiSettings,
    ["--list-models"],
    environment,
  ).pipe(Effect.timeoutOption(LIST_MODELS_PROBE_TIMEOUT_MS), Effect.result);
  const listModelsOutput =
    Result.isSuccess(listModelsResult) &&
    Option.isSome(listModelsResult.success) &&
    listModelsResult.success.value.code === 0
      ? listModelsResult.success.value
      : undefined;
  if (!listModelsOutput) {
    yield* Effect.logWarning("Kimchi CLI model listing failed or timed out.", {
      errorTag: Result.isFailure(listModelsResult)
        ? listModelsResult.failure._tag
        : Option.isNone(listModelsResult.success)
          ? "Timeout"
          : `ExitCode${listModelsResult.success.value.code}`,
    });
  }
  const cliAuth = listModelsOutput
    ? parseKimchiListModelsOutput(`${listModelsOutput.stdout}\n${listModelsOutput.stderr}`)
    : undefined;

  const auth: ServerProviderAuth = environment[KIMCHI_API_KEY_ENV]?.trim()
    ? { status: "authenticated", type: "api_key", label: "Kimchi API key" }
    : cliAuth?.authenticated === true
      ? { status: "authenticated", type: "cached_token", label: "Kimchi account" }
      : cliAuth?.authenticated === false
        ? { status: "unauthenticated" }
        : { status: "unknown" };

  if (auth.status === "unauthenticated") {
    return buildKimchiServerProvider({
      presentation: KIMCHI_PRESENTATION,
      enabled: kimchiSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version,
        status: "error",
        auth,
        message: "Kimchi CLI is installed but not logged in. Run `kimchi login`.",
      },
    });
  }

  const discoveredModels = cliAuth?.models ?? [];
  const models =
    discoveredModels.length > 0
      ? kimchiModelsFromSettings(kimchiSettings.customModels, discoveredModels)
      : fallbackModels;

  return buildKimchiServerProvider({
    presentation: KIMCHI_PRESENTATION,
    enabled: kimchiSettings.enabled,
    checkedAt,
    models,
    probe: {
      installed: true,
      version,
      status: "ready",
      auth,
    },
  });
});

export const enrichKimchiSnapshot = (input: {
  readonly snapshot: ServerProvider;
  readonly maintenanceCapabilities: ProviderMaintenanceCapabilities;
  readonly enableProviderUpdateChecks?: boolean;
  readonly publishSnapshot: (snapshot: ServerProvider) => Effect.Effect<void>;
  readonly httpClient: HttpClient.HttpClient;
}): Effect.Effect<void> => {
  const { snapshot, publishSnapshot } = input;

  return enrichProviderSnapshotWithVersionAdvisory(snapshot, input.maintenanceCapabilities, {
    enableProviderUpdateChecks: input.enableProviderUpdateChecks,
  }).pipe(
    Effect.provideService(HttpClient.HttpClient, input.httpClient),
    Effect.flatMap((enrichedSnapshot) => publishSnapshot(enrichedSnapshot)),
    Effect.catchCause((cause) =>
      Effect.logWarning("Kimchi version advisory enrichment failed", {
        errorTag: causeErrorTag(cause),
      }),
    ),
    Effect.asVoid,
  );
};
