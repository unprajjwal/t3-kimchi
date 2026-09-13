import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import { KimchiSettings } from "@t3tools/contracts";

import {
  buildInitialKimchiProviderSnapshot,
  checkKimchiProviderStatus,
  parseKimchiListModelsOutput,
} from "./KimchiProvider.ts";
import { writeFakeCli } from "../../testUtils/fakeCli.ts";

const decodeKimchiSettings = Schema.decodeSync(KimchiSettings);

const LIST_MODELS_TABLE_OUTPUT = [
  '[model-roles] Warning: explorer model "kimchi-dev/deepseek-v4-flash" is not available. Subagents for this role will fall back to the parent model.',
  "provider    model                   context  max-out  thinking  images",
  "kimchi-dev  deepseek-v4-flash-0731  1.0M     512K     yes       no    ",
  "kimchi-dev  glm-5.3                 1.0M     131.1K   yes       no    ",
  "kimchi-dev  minimax-m3              1.0M     524.3K   yes       yes   ",
  "",
].join("\n");

describe("parseKimchiListModelsOutput", () => {
  it("detects the unauthenticated banner even though the flag exits 0", () => {
    const parsed = parseKimchiListModelsOutput(
      "No models available. Use /login to log into a provider via OAuth or API key.\n",
    );
    expect(parsed.authenticated).toBe(false);
    expect(parsed.models).toEqual([]);
  });

  it("parses the authenticated model table, joining provider/model into a slug", () => {
    const parsed = parseKimchiListModelsOutput(LIST_MODELS_TABLE_OUTPUT);
    expect(parsed.authenticated).toBe(true);
    expect(parsed.models.map((model) => [model.slug, model.name])).toEqual([
      ["kimchi-dev/deepseek-v4-flash-0731", "deepseek-v4-flash-0731"],
      ["kimchi-dev/glm-5.3", "glm-5.3"],
      ["kimchi-dev/minimax-m3", "minimax-m3"],
    ]);
    expect(parsed.models.every((model) => model.isCustom === false)).toBe(true);
  });

  it("treats a non-empty model listing as authenticated even without a recognized table header", () => {
    expect(
      parseKimchiListModelsOutput("kimchi-dev/minimax-m3\nanthropic/claude-sonnet-5-2\n")
        .authenticated,
    ).toBe(true);
  });

  it("treats empty output as unauthenticated", () => {
    expect(parseKimchiListModelsOutput("").authenticated).toBe(false);
    expect(parseKimchiListModelsOutput("   \n").authenticated).toBe(false);
  });
});

describe("buildInitialKimchiProviderSnapshot", () => {
  it.effect("returns a disabled snapshot when settings.enabled is false", () =>
    Effect.gen(function* () {
      const snapshot = yield* buildInitialKimchiProviderSnapshot(
        decodeKimchiSettings({ enabled: false }),
      );
      expect(snapshot.enabled).toBe(false);
      expect(snapshot.status).toBe("disabled");
      expect(snapshot.installed).toBe(false);
      expect(snapshot.message).toContain("disabled");
    }),
  );

  it.effect("returns a disabled snapshot by default — Kimchi is opt-in", () =>
    Effect.gen(function* () {
      const snapshot = yield* buildInitialKimchiProviderSnapshot(decodeKimchiSettings({}));
      expect(snapshot.enabled).toBe(false);
      expect(snapshot.status).toBe("disabled");
    }),
  );

  it.effect("returns a pending snapshot when enabled", () =>
    Effect.gen(function* () {
      const snapshot = yield* buildInitialKimchiProviderSnapshot(
        decodeKimchiSettings({ enabled: true }),
      );
      expect(snapshot.enabled).toBe(true);
      expect(snapshot.installed).toBe(true);
      expect(snapshot.status).toBe("warning");
      expect(snapshot.version).toBeNull();
      expect(snapshot.message).toContain("Checking Kimchi");
      expect(snapshot.supportsConversationRollback).toBe(false);
    }),
  );
});

it.layer(NodeServices.layer)("checkKimchiProviderStatus", (it) => {
  it.effect("reports the binary as missing when the binary path does not resolve", () =>
    Effect.gen(function* () {
      const snapshot = yield* checkKimchiProviderStatus(
        decodeKimchiSettings({
          enabled: true,
          binaryPath: "/definitely/not/installed/kimchi-binary",
        }),
      );
      expect(snapshot.enabled).toBe(true);
      expect(snapshot.installed).toBe(false);
      expect(snapshot.status).toBe("error");
      expect(snapshot.message).toMatch(/not installed|not on PATH|Failed to execute/);
    }),
  );

  it.effect("reports unauthenticated when `--list-models` prints the login banner", () =>
    Effect.gen(function* () {
      const snapshot = yield* Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-kimchi-auth-" });
          const kimchiPath = writeFakeCli({
            directory: dir,
            name: "kimchi",
            source: [
              "const args = process.argv.slice(2);",
              'if (args[0] === "version") {',
              '  process.stdout.write("kimchi 1.1.18\\n  platform: darwin/arm64\\n  node: v26.3.0\\n");',
              "  process.exit(0);",
              "}",
              'if (args[0] === "--list-models") {',
              '  process.stdout.write("No models available. Use /login to log into a provider via OAuth or API key.\\n");',
              "  process.exit(0);",
              "}",
              "process.exit(1);",
              "",
            ].join("\n"),
          });
          return yield* checkKimchiProviderStatus(
            decodeKimchiSettings({ enabled: true, binaryPath: kimchiPath }),
          );
        }),
      );
      expect(snapshot.installed).toBe(true);
      expect(snapshot.version).toBe("1.1.18");
      expect(snapshot.status).toBe("error");
      expect(snapshot.auth).toEqual({ status: "unauthenticated" });
      expect(snapshot.message).toContain("not logged in");
    }),
  );

  it.effect("reports ready when `--list-models` lists models", () =>
    Effect.gen(function* () {
      const snapshot = yield* Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-kimchi-ready-" });
          const kimchiPath = writeFakeCli({
            directory: dir,
            name: "kimchi",
            source: [
              "const args = process.argv.slice(2);",
              'if (args[0] === "version") {',
              '  process.stdout.write("kimchi 1.1.18\\n");',
              "  process.exit(0);",
              "}",
              'if (args[0] === "--list-models") {',
              // @effect-diagnostics-next-line preferSchemaOverJson:off
              `  process.stdout.write(${JSON.stringify(LIST_MODELS_TABLE_OUTPUT)});`,
              "  process.exit(0);",
              "}",
              "process.exit(1);",
              "",
            ].join("\n"),
          });
          return yield* checkKimchiProviderStatus(
            decodeKimchiSettings({ enabled: true, binaryPath: kimchiPath }),
          );
        }),
      );
      expect(snapshot.installed).toBe(true);
      expect(snapshot.status).toBe("ready");
      expect(snapshot.auth).toEqual({
        status: "authenticated",
        type: "cached_token",
        label: "Kimchi account",
      });
      expect(snapshot.models.map((model) => model.slug)).toEqual([
        "kimchi-dev/deepseek-v4-flash-0731",
        "kimchi-dev/glm-5.3",
        "kimchi-dev/minimax-m3",
      ]);
    }),
  );

  it.effect("treats KIMCHI_API_KEY as authenticated regardless of CLI login state", () =>
    Effect.gen(function* () {
      const snapshot = yield* Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-kimchi-apikey-" });
          const kimchiPath = writeFakeCli({
            directory: dir,
            name: "kimchi",
            source: [
              "const args = process.argv.slice(2);",
              'if (args[0] === "version") {',
              '  process.stdout.write("kimchi 1.1.18\\n");',
              "  process.exit(0);",
              "}",
              'if (args[0] === "--list-models") {',
              '  process.stdout.write("No models available. Use /login to log into a provider via OAuth or API key.\\n");',
              "  process.exit(0);",
              "}",
              "process.exit(1);",
              "",
            ].join("\n"),
          });
          return yield* checkKimchiProviderStatus(
            decodeKimchiSettings({ enabled: true, binaryPath: kimchiPath }),
            { ...process.env, KIMCHI_API_KEY: "secret" },
          );
        }),
      );
      expect(snapshot.status).toBe("ready");
      expect(snapshot.auth).toEqual({
        status: "authenticated",
        type: "api_key",
        label: "Kimchi API key",
      });
    }),
  );
});
