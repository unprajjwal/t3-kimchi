import { type KimchiSettings, type RuntimeMode } from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import type * as EffectAcpErrors from "effect-acp/errors";

import * as AcpSessionRuntime from "./AcpSessionRuntime.ts";

type KimchiAcpRuntimeKimchiSettings = Pick<KimchiSettings, "binaryPath">;

export interface KimchiAcpRuntimeInput extends Omit<
  AcpSessionRuntime.AcpSessionRuntimeOptions,
  "authMethodId" | "clientCapabilities" | "spawn" | "resumeMethod"
> {
  readonly childProcessSpawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly kimchiSettings: KimchiAcpRuntimeKimchiSettings | null | undefined;
  readonly environment?: NodeJS.ProcessEnv;
  readonly runtimeMode?: RuntimeMode;
}

/**
 * Kimchi's permission mode is a launch-time CLI flag (`--plan`/`--auto`/`--yolo`,
 * default when omitted), not an ACP session config option. Kimchi has no
 * "auto-accept-edits"-only mode distinct from full auto, so
 * `auto-accept-edits` conservatively falls back to the default (fully manual)
 * mode rather than silently granting more autonomy than requested.
 */
export function kimchiAcpPermissionArgs(runtimeMode?: RuntimeMode): ReadonlyArray<string> {
  switch (runtimeMode) {
    case "auto":
      return ["--auto"];
    case "full-access":
      return ["--yolo"];
    default:
      return [];
  }
}

export function buildKimchiAcpSpawnInput(
  kimchiSettings: KimchiAcpRuntimeKimchiSettings | null | undefined,
  cwd: string,
  environment?: NodeJS.ProcessEnv,
  runtimeMode?: RuntimeMode,
): AcpSessionRuntime.AcpSpawnInput {
  return {
    command: kimchiSettings?.binaryPath || "kimchi",
    args: ["--mode", "acp", ...kimchiAcpPermissionArgs(runtimeMode)],
    cwd,
    ...(environment ? { env: environment } : {}),
  };
}

export const makeKimchiAcpRuntime = (
  input: KimchiAcpRuntimeInput,
): Effect.Effect<
  AcpSessionRuntime.AcpSessionRuntime["Service"],
  EffectAcpErrors.AcpError,
  Crypto.Crypto | Scope.Scope
> =>
  Effect.gen(function* () {
    const acpContext = yield* Layer.build(
      AcpSessionRuntime.layer({
        ...input,
        spawn: buildKimchiAcpSpawnInput(
          input.kimchiSettings,
          input.cwd,
          input.environment,
          input.runtimeMode,
        ),
        // Omit `authMethodId` entirely: the CLI already resolves credentials
        // ambiently before the ACP handshake even starts (it eagerly
        // validates `KIMCHI_API_KEY`/stored config against its model-list
        // endpoint and exits on a bad key, before answering `initialize`).
        // Kimchi's one advertised auth method, `kimchi-agent`, is real
        // interactive browser OAuth — calling `authenticate` with it opens
        // a fresh reauth prompt on every session start even when already
        // logged in, confirmed live: `session/new` succeeds immediately
        // with zero `authenticate` call once `kimchi login` has stored a
        // valid key.
        // Kimchi's agent persists sessions to `.kimchi/` files and reloads them
        // with `session/load`; `agentCapabilities.sessionCapabilities` has no
        // `resume` entry, so `session/resume` is not supported.
        resumeMethod: "load",
      }).pipe(
        Layer.provide(
          Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, input.childProcessSpawner),
        ),
      ),
    );
    return yield* Effect.service(AcpSessionRuntime.AcpSessionRuntime).pipe(
      Effect.provide(acpContext),
    );
  });
