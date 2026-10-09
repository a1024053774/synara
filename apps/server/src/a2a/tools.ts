import { A2AGateRequest } from "@synara/contracts";
import type { A2AGates } from "@synara/a2a-gates";
import { Effect, Schema } from "effect";
import { mcpToolResultJson } from "../agentGateway/protocol";
import { WRITE_TOOL_ANNOTATIONS, type ToolEntry } from "../agentGateway/toolRuntime";

export function a2aSubmitTool(gates: A2AGates): ToolEntry {
  return {
    definition: {
      name: "a2a_submit",
      description:
        "Deliver your managed attempt. Supply the frozen task, attempt, session, fence, spec_rev, and full commit SHA. This tool validates your active thread and turn; completion alone does not deliver work.",
      annotations: WRITE_TOOL_ANNOTATIONS,
      inputSchema: {
        type: "object",
        required: ["task", "attempt", "session", "fence", "spec_rev", "commit"],
        properties: {
          task: { type: "string" },
          attempt: { type: "string" },
          session: { type: "string" },
          fence: { type: "integer" },
          spec_rev: { type: "integer" },
          commit: { type: "string" },
        },
        additionalProperties: false,
      },
    },
    requiredCapability: "thread:write",
    requiresActiveTurn: true,
    handler: (args, context) =>
      Effect.gen(function* () {
        const request = yield* Schema.decodeUnknownEffect(A2AGateRequest)({
          ...args,
          command: "submit",
        });
        const result = yield* Effect.promise(() =>
          gates.call(request, {
            thread: context.callerThreadId,
            turn: context.callerTurnId ?? "",
            assertActive: () => Effect.runPromise(context.assertCallerTurnActive()),
          }),
        );
        return { ...mcpToolResultJson(result), ...(!result.ok ? { isError: true as const } : {}) };
      }).pipe(
        Effect.catch((error) =>
          Effect.succeed({
            ...mcpToolResultJson({ ok: false, error: "invalid_submit", details: String(error) }),
            isError: true as const,
          }),
        ),
      ),
  };
}

export function a2aRaiseTool(gates: A2AGates): ToolEntry {
  const input = Schema.Struct({
    title: Schema.String,
    body: Schema.optional(Schema.String),
    blocking: Schema.optional(Schema.Boolean),
    refs: Schema.optional(Schema.Array(Schema.String)),
  });
  return {
    definition: {
      name: "a2a_raise",
      description:
        "Report an issue outside your task scope. Supply a title and optional body, blocking flag, and references. Your credential identifies the thread. An active turn is required. This tool does not change task status.",
      annotations: WRITE_TOOL_ANNOTATIONS,
      inputSchema: {
        type: "object",
        required: ["title"],
        properties: {
          title: { type: "string" },
          body: { type: "string" },
          blocking: { type: "boolean" },
          refs: { type: "array", items: { type: "string" } },
        },
        additionalProperties: false,
      },
    },
    requiredCapability: "thread:write",
    requiresActiveTurn: true,
    handler: (args, context) =>
      Effect.gen(function* () {
        const decoded = yield* Schema.decodeUnknownEffect(input)(args);
        const result = yield* Effect.promise(() =>
          gates.raiseIssue(
            {
              title: decoded.title,
              body: decoded.body ?? "",
              blocking: decoded.blocking ?? false,
              refs: decoded.refs ?? [],
            },
            {
              thread: context.callerThreadId,
              turn: context.callerTurnId ?? "",
              assertActive: () => Effect.runPromise(context.assertCallerTurnActive()),
            },
          ),
        );
        return mcpToolResultJson(result);
      }).pipe(
        Effect.catch((error) =>
          Effect.succeed({
            ...mcpToolResultJson({ ok: false, error: "issue_refused", details: String(error) }),
            isError: true as const,
          }),
        ),
      ),
  };
}
