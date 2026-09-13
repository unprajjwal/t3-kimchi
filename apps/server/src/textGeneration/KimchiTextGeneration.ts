/**
 * KimchiTextGeneration — stub. `textGeneration` is a required field on
 * `ProviderInstance`, but Kimchi's ACP integration does not yet drive the
 * one-shot commit-message/PR/branch-name/thread-title flows the other
 * drivers implement by spawning a throwaway ACP session per call (see
 * GrokTextGeneration.ts). Every operation fails with a clear
 * `TextGenerationError` instead of silently no-op succeeding.
 *
 * @module KimchiTextGeneration
 */
import * as Effect from "effect/Effect";

import { TextGenerationError } from "@t3tools/contracts";
import * as TextGeneration from "./TextGeneration.ts";

const unsupported = (operation: string) =>
  Effect.fail(
    new TextGenerationError({
      operation,
      detail: "Kimchi does not support text generation in T3 Code yet.",
    }),
  );

export const makeKimchiTextGeneration: Effect.Effect<TextGeneration.TextGeneration["Service"]> =
  Effect.succeed(
    TextGeneration.TextGeneration.of({
      generateCommitMessage: () => unsupported("generateCommitMessage"),
      generatePrContent: () => unsupported("generatePrContent"),
      generateBranchName: () => unsupported("generateBranchName"),
      generateThreadTitle: () => unsupported("generateThreadTitle"),
    }),
  );
