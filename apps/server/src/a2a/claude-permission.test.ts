import * as NodeServices from "@effect/platform-node/NodeServices";
import { ThreadId } from "@synara/contracts";
import type { Options } from "@anthropic-ai/claude-agent-sdk";
import { Effect, Layer, Stream } from "effect";
import { expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ServerConfig } from "../config";
import {
  AgentGatewayCredentials,
  type AgentGatewayCredentialsShape,
} from "../agentGateway/Services/AgentGatewayCredentials";
import { ClaudeAdapter } from "../provider/Services/ClaudeAdapter";
import { makeClaudeAdapterLive } from "../provider/Layers/ClaudeAdapter";

// Failure list: SDK override omitted/fails silently; checked tool prompts;
// unchecked tool inherits full-access or coordinator grant; idle/ordinary/
// revoked identity auto-approved. Native transport is controlled; the real
// adapter builds the policy and emits the actual request.opened event.
it.each(["checked", "unchecked", "idle", "ordinary", "revoked"])(
  "Claude native policy: %s",
  async (condition) => {
    let options: Options | undefined;
    let endStream: ((value: IteratorResult<never>) => void) | undefined;
    const overrides: string[] = [];
    const query = {
      interrupt: async () => {},
      stopTask: async () => {},
      backgroundTasks: async () => false,
      setModel: async () => {},
      setPermissionMode: async () => {},
      setMaxThinkingTokens: async () => {},
      applyFlagSettings: async () => {},
      getContextUsage: async () => ({}) as never,
      supportedCommands: async () => [],
      supportedModels: async () => [],
      supportedAgents: async () => [],
      setMcpPermissionModeOverride: async (server: string, mode: string) => {
        overrides.push(server + ":" + mode);
        return {};
      },
      close: () => endStream?.({ done: true, value: undefined as never }),
      [Symbol.asyncIterator]: () => ({
        next: () =>
          new Promise<IteratorResult<never>>((resolve) => {
            endStream = resolve;
          }),
      }),
    };
    const credentials = {
      connectionForThread: () => ({
        url: "http://127.0.0.1:49999/mcp",
        bearerToken: "controlled-token",
        a2aPermissions: () =>
          condition === "ordinary"
            ? undefined
            : condition === "revoked"
              ? null
              : {
                  role: "executor" as const,
                  autoApproveTools: condition === "unchecked" ? [] : ["a2a_disposition"],
                },
      }),
      revokeSessionToken: () => {},
      cancelSessionTurnRequests: async () => {},
      retireSessionTurn: async () => {},
      issueStdioBootstrapToken: () => null,
    } as unknown as AgentGatewayCredentialsShape;
    const root = mkdtempSync(join(tmpdir(), "t064-claude-"));
    const layer = makeClaudeAdapterLive({
      readClaudeCliVersion: async () => "2.1.296",
      createQuery: (input) => {
        options = input.options;
        return query;
      },
    }).pipe(
      Layer.provideMerge(Layer.succeed(AgentGatewayCredentials, credentials)),
      Layer.provideMerge(ServerConfig.layerTest(root, root)),
      Layer.provideMerge(NodeServices.layer),
    );
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const adapter = yield* ClaudeAdapter;
          const threadId = ThreadId.makeUnsafe("t064-native-" + condition);
          yield* adapter.startSession({
            threadId,
            runtimeMode: "full-access",
            autoApproveSynaraTools: true,
          });
          yield* Effect.addFinalizer(() => adapter.stopSession(threadId).pipe(Effect.orDie));
          expect(overrides).toEqual(["synara:default"]);
          if (condition !== "idle")
            yield* adapter.sendTurn({ threadId, input: "controlled native turn", attachments: [] });
          const abort = new AbortController();
          const pending = options!.canUseTool!(
            "mcp__synara__a2a_disposition",
            { action: "close" },
            { signal: abort.signal, toolUseID: "t064-call", requestId: "t064-native-request" },
          );
          if (condition === "checked") {
            const result = yield* Effect.promise(() => pending);
            expect(result?.behavior).toBe("allow");
          } else {
            const event = yield* adapter.streamEvents.pipe(
              Stream.filter((value) => value.type === "request.opened"),
              Stream.runHead,
            );
            expect(event._tag).toBe("Some");
            abort.abort();
            const result = yield* Effect.promise(() => pending);
            expect(result?.behavior).toBe("deny");
          }
        }),
      ).pipe(Effect.provide(layer)),
    );
  },
);
