// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import * as NodeFSP from "node:fs/promises";
import * as NodeURL from "node:url";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import {
  ApprovalRequestId,
  KimchiSettings,
  ProviderDriverKind,
  type ProviderRuntimeEvent,
  ThreadId,
  ProviderInstanceId,
} from "@t3tools/contracts";

import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import type { KimchiAdapterShape } from "../Services/KimchiAdapter.ts";
import { makeKimchiAdapter } from "./KimchiAdapter.ts";
import { execScriptSource, writeFakeCli } from "../../testUtils/fakeCli.ts";
const decodeKimchiSettings = Schema.decodeSync(KimchiSettings);

// Test-local service tag so the rest of the file can keep using `yield* KimchiAdapter`.
class KimchiAdapter extends Context.Service<KimchiAdapter, KimchiAdapterShape>()(
  "t3/provider/Layers/KimchiAdapter.test/KimchiAdapter",
) {}

const __dirname = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
// Shared, protocol-only ACP mock agent (also used by Cursor's and Antigravity's
// adapter tests). Its behavior is driven entirely by env vars, not by argv or
// binary name, so it works unmodified against Kimchi's `--mode acp` spawn.
const mockAgentPath = NodePath.join(__dirname, "../../../scripts/acp-mock-agent.ts");

async function makeMockAgentWrapper(extraEnv?: Record<string, string>) {
  const dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "kimchi-acp-mock-"));
  return writeFakeCli({
    directory: dir,
    name: "fake-agent",
    env: extraEnv ?? {},
    source: execScriptSource({ scriptPath: mockAgentPath }),
  });
}

// Tests mutate `ServerSettingsService` mid-flight (setting
// `providers.kimchi.binaryPath` to a mock ACP wrapper). The adapter captures
// `kimchiSettings` once at construction, so without a resolver the mutation
// is invisible — sessions would spawn the constructor's (empty) binary path.
const makeResolveKimchiSettings = Effect.gen(function* () {
  const serverSettings = yield* ServerSettingsService;
  return yield* Effect.succeed(
    serverSettings.getSettings.pipe(
      Effect.map((snapshot) => snapshot.providers.kimchi),
      Effect.orDie,
    ),
  );
});

const kimchiAdapterTestLayer = it.layer(
  Layer.effect(
    KimchiAdapter,
    Effect.gen(function* () {
      const kimchiConfig = decodeKimchiSettings({});
      const resolveSettings = yield* makeResolveKimchiSettings;
      return yield* makeKimchiAdapter(kimchiConfig, { resolveSettings });
    }),
  ).pipe(
    Layer.provideMerge(ServerSettingsService.layerTest()),
    Layer.provideMerge(
      ServerConfig.layerTest(process.cwd(), {
        prefix: "t3code-kimchi-adapter-test-",
      }),
    ),
    Layer.provideMerge(NodeServices.layer),
  ),
);

kimchiAdapterTestLayer("KimchiAdapterLive", (it) => {
  it.effect("starts a session and maps mock ACP prompt flow to runtime events", () =>
    Effect.gen(function* () {
      const adapter = yield* KimchiAdapter;
      const settings = yield* ServerSettingsService;
      const threadId = ThreadId.make("kimchi-mock-thread");

      const wrapperPath = yield* Effect.promise(() => makeMockAgentWrapper());
      yield* settings.updateSettings({ providers: { kimchi: { binaryPath: wrapperPath } } });

      const runtimeEventsFiber = yield* Stream.take(adapter.streamEvents, 9).pipe(
        Stream.runCollect,
        Effect.forkChild,
      );

      const session = yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("kimchi"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
        modelSelection: { instanceId: ProviderInstanceId.make("kimchi"), model: "default" },
      });

      assert.equal(session.provider, "kimchi");
      assert.deepStrictEqual(session.resumeCursor, {
        schemaVersion: 1,
        sessionId: "mock-session-1",
      });

      yield* adapter.sendTurn({
        threadId,
        input: "hello mock",
        attachments: [],
      });

      const runtimeEvents = Array.from(yield* Fiber.join(runtimeEventsFiber));
      const types = runtimeEvents.map((e) => e.type);

      for (const t of [
        "session.started",
        "session.state.changed",
        "thread.started",
        "turn.started",
        "item.started",
        "content.delta",
        "item.completed",
        "turn.completed",
      ] as const) {
        assert.include(types, t);
      }

      const delta = runtimeEvents.find((e) => e.type === "content.delta");
      assert.isDefined(delta);
      if (delta?.type === "content.delta") {
        assert.equal(delta.payload.delta, "hello from mock");
        assert.match(String(delta.itemId), /^assistant:mock-session-1:runtime:[^:]+:segment:0$/);
      }

      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect(
    "streams ACP tool calls and approvals on the active turn in approval-required mode",
    () =>
      Effect.gen(function* () {
        const adapter = yield* KimchiAdapter;
        const serverSettings = yield* ServerSettingsService;
        const threadId = ThreadId.make("kimchi-tool-call-probe");
        const runtimeEvents: Array<ProviderRuntimeEvent> = [];
        const settledEventTypes = new Set<string>();
        const settledEventsReady = yield* Deferred.make<void>();

        const wrapperPath = yield* Effect.promise(() =>
          makeMockAgentWrapper({ T3_ACP_EMIT_TOOL_CALLS: "1" }),
        );
        yield* serverSettings.updateSettings({
          providers: { kimchi: { binaryPath: wrapperPath } },
        });

        yield* Stream.runForEach(adapter.streamEvents, (event) =>
          Effect.gen(function* () {
            runtimeEvents.push(event);
            if (String(event.threadId) !== String(threadId)) {
              return;
            }
            if (event.type === "request.opened" && event.requestId) {
              yield* adapter.respondToRequest(
                threadId,
                ApprovalRequestId.make(String(event.requestId)),
                "accept",
              );
            }
            if (
              event.type === "turn.completed" ||
              (event.type === "item.completed" && event.payload.itemType === "command_execution") ||
              event.type === "content.delta"
            ) {
              settledEventTypes.add(event.type);
              if (settledEventTypes.size === 3) {
                yield* Deferred.succeed(settledEventsReady, undefined).pipe(Effect.orDie);
              }
            }
          }),
        ).pipe(Effect.forkChild);

        yield* adapter.startSession({
          threadId,
          provider: ProviderDriverKind.make("kimchi"),
          cwd: process.cwd(),
          runtimeMode: "approval-required",
          modelSelection: { instanceId: ProviderInstanceId.make("kimchi"), model: "default" },
        });

        const turn = yield* adapter.sendTurn({
          threadId,
          input: "run a tool call",
          attachments: [],
        });
        yield* Deferred.await(settledEventsReady);

        const threadEvents = runtimeEvents.filter(
          (event) => String(event.threadId) === String(threadId),
        );
        assert.includeMembers(
          threadEvents.map((event) => event.type),
          [
            "session.started",
            "thread.started",
            "turn.started",
            "request.opened",
            "request.resolved",
            "item.updated",
            "item.completed",
            "content.delta",
            "turn.completed",
          ],
        );

        const turnEvents = threadEvents.filter(
          (event) => String(event.turnId) === String(turn.turnId),
        );

        const requestOpened = turnEvents.find((event) => event.type === "request.opened");
        assert.isDefined(requestOpened);
        if (requestOpened?.type === "request.opened") {
          assert.equal(requestOpened.payload.requestType, "exec_command_approval");
          assert.equal(requestOpened.payload.detail, "cat server/package.json");
        }

        const requestResolved = turnEvents.find((event) => event.type === "request.resolved");
        assert.isDefined(requestResolved);
        if (requestResolved?.type === "request.resolved") {
          assert.equal(requestResolved.payload.decision, "accept");
        }

        const toolCompleted = turnEvents.find(
          (event) =>
            event.type === "item.completed" && event.payload.itemType === "command_execution",
        );
        assert.isDefined(toolCompleted);

        yield* adapter.stopSession(threadId);
      }),
  );

  it.effect("cancels a pending approval and completes the turn when interrupted", () =>
    Effect.gen(function* () {
      const adapter = yield* KimchiAdapter;
      const serverSettings = yield* ServerSettingsService;
      const threadId = ThreadId.make("kimchi-cancel-probe");

      const wrapperPath = yield* Effect.promise(() =>
        makeMockAgentWrapper({ T3_ACP_EMIT_TOOL_CALLS: "1" }),
      );
      yield* serverSettings.updateSettings({ providers: { kimchi: { binaryPath: wrapperPath } } });

      const requestResolvedReady = yield* Deferred.make<ProviderRuntimeEvent>();
      const turnCompletedReady = yield* Deferred.make<ProviderRuntimeEvent>();
      let interrupted = false;

      const runtimeEventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.gen(function* () {
          if (String(event.threadId) !== String(threadId)) {
            return;
          }
          if (event.type === "request.opened" && event.requestId && !interrupted) {
            interrupted = true;
            yield* adapter.respondToRequest(
              threadId,
              ApprovalRequestId.make(String(event.requestId)),
              "cancel",
            );
            yield* adapter.interruptTurn(threadId);
            return;
          }
          if (event.type === "request.resolved") {
            yield* Deferred.succeed(requestResolvedReady, event).pipe(Effect.ignore);
            return;
          }
          if (event.type === "turn.completed") {
            yield* Deferred.succeed(turnCompletedReady, event).pipe(Effect.ignore);
          }
        }),
      ).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("kimchi"),
        cwd: process.cwd(),
        runtimeMode: "approval-required",
        modelSelection: { instanceId: ProviderInstanceId.make("kimchi"), model: "default" },
      });

      const sendTurnFiber = yield* adapter
        .sendTurn({ threadId, input: "cancel this turn", attachments: [] })
        .pipe(Effect.forkChild);

      const requestResolved = yield* Deferred.await(requestResolvedReady);
      const turnCompleted = yield* Deferred.await(turnCompletedReady);
      yield* Fiber.join(sendTurnFiber);
      yield* Fiber.interrupt(runtimeEventsFiber);

      assert.equal(requestResolved.type, "request.resolved");
      if (requestResolved.type === "request.resolved") {
        assert.equal(requestResolved.payload.decision, "cancel");
      }

      assert.equal(turnCompleted.type, "turn.completed");
      if (turnCompleted.type === "turn.completed") {
        assert.equal(turnCompleted.payload.state, "cancelled");
        assert.equal(turnCompleted.payload.stopReason, "cancelled");
      }

      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("rejects rollback without discarding the provider conversation", () =>
    Effect.gen(function* () {
      const adapter = yield* KimchiAdapter;
      const settings = yield* ServerSettingsService;
      const threadId = ThreadId.make("kimchi-unsupported-rollback");
      const wrapperPath = yield* Effect.promise(() => makeMockAgentWrapper());
      yield* settings.updateSettings({ providers: { kimchi: { binaryPath: wrapperPath } } });
      yield* adapter.startSession({
        threadId,
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({ threadId, input: "Remember this turn", attachments: [] });
      const originalTurns = [...(yield* adapter.readThread(threadId)).turns];
      assert.isFalse(adapter.capabilities.supportsConversationRollback);
      const error = yield* adapter.rollbackThread(threadId, 1).pipe(Effect.flip);
      assert.equal(error._tag, "ProviderAdapterRequestError");
      assert.deepStrictEqual((yield* adapter.readThread(threadId)).turns, originalTurns);
      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("rejects respondToUserInput — Kimchi has no user-input extension", () =>
    Effect.gen(function* () {
      const adapter = yield* KimchiAdapter;
      const settings = yield* ServerSettingsService;
      const threadId = ThreadId.make("kimchi-no-user-input");
      const wrapperPath = yield* Effect.promise(() => makeMockAgentWrapper());
      yield* settings.updateSettings({ providers: { kimchi: { binaryPath: wrapperPath } } });
      yield* adapter.startSession({ threadId, cwd: process.cwd(), runtimeMode: "full-access" });
      const error = yield* adapter
        .respondToUserInput(threadId, ApprovalRequestId.make("does-not-exist"), {})
        .pipe(Effect.flip);
      assert.equal(error._tag, "ProviderAdapterRequestError");
      yield* adapter.stopSession(threadId);
    }),
  );
});
