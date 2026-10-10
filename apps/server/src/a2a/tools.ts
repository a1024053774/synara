import { A2AGateRequest, A2AIssueAction, A2AInboxRequest, A2AStopRequest } from "@synara/contracts";
import type { A2AGates } from "@synara/a2a-gates";
import { Effect, Schema } from "effect";
import { mcpToolResultJson } from "../agentGateway/protocol";
import {
  WRITE_TOOL_ANNOTATIONS,
  READ_ONLY_TOOL_ANNOTATIONS,
  type ToolEntry,
  type ToolContext,
} from "../agentGateway/toolRuntime";

function caller(context: ToolContext) {
  return {
    thread: context.callerThreadId,
    turn: context.callerTurnId ?? "",
    assertActive: () => Effect.runPromise(context.assertCallerTurnActive()),
    ...(context.callerCapabilities.has("a2a:operate")
      ? { address: "executor" }
      : context.callerCapabilities.has("a2a:stop")
        ? { address: "ideation" }
        : {}),
  };
}

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
    requiredCapability: "a2a:submit",
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
    requiredCapability: "a2a:raise",
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

export function a2aDispositionTool(gates: A2AGates): ToolEntry {
  const input = Schema.Struct({
    task: Schema.String,
    issue: Schema.String,
    action: A2AIssueAction,
    reason: Schema.optional(Schema.String),
    basis: Schema.optional(Schema.String),
  });
  return {
    definition: {
      name: "a2a_disposition",
      description:
        "Append one disposition record for an issue in your task. Only a controller session can use this tool. The credential supplies your identity. An active turn is required.\n\nFor close, supply reason and basis. You cannot close a blocking issue or send a user answer. Only the user can reopen, snooze, or dismiss an issue.",
      annotations: WRITE_TOOL_ANNOTATIONS,
      inputSchema: {
        type: "object",
        required: ["task", "issue", "action"],
        properties: {
          task: { type: "string" },
          issue: { type: "string" },
          action: {
            type: "string",
            enum: ["close", "needs-user", "forward", "reopen", "snooze", "dismiss", "delivered"],
          },
          reason: { type: "string" },
          basis: { type: "string" },
        },
        additionalProperties: false,
      },
    },
    requiredCapability: "a2a:inbox",
    requiresActiveTurn: true,
    handler: (args, context) =>
      Effect.gen(function* () {
        const decoded = yield* Schema.decodeUnknownEffect(input)(args);
        const result = yield* Effect.promise(() =>
          gates.call({ ...decoded, command: "disposition" }, caller(context)),
        );
        return { ...mcpToolResultJson(result), ...(!result.ok ? { isError: true as const } : {}) };
      }).pipe(
        Effect.catchTag("SchemaError", (error) =>
          Effect.succeed({
            ...mcpToolResultJson({
              ok: false,
              error: "invalid_disposition",
              details: String(error),
            }),
            isError: true as const,
          }),
        ),
      ),
  };
}

/** All transports call the same core. No tool implements gate state. */
export function a2aControllerTools(gates: A2AGates): ToolEntry[] {
  const properties = {
    task: { type: "string" },
    repo: { type: "string" },
    project: { type: "string" },
    title: { type: "string" },
    base: { type: "string" },
    oracle: { type: "string" },
    instructions: { type: "string" },
    owner: { type: "string" },
    reason: { type: "string" },
    attempt: { type: "string" },
    thread: { type: "string" },
    spec_rev: { type: "integer" },
    wait_seconds: { type: "integer" },
    role: { type: "string", enum: ["controller", "worker", "reviewer", "monitor"] },
    preset: { type: "string", enum: ["executor", "ideation", "worker", "reviewer", "monitor"] },
    modelSelection: {
      type: "object",
      required: ["provider", "model"],
      properties: {
        provider: { type: "string" },
        model: { type: "string" },
        options: { type: "object" },
      },
      additionalProperties: false,
    },
    runtimeMode: { type: "string", enum: ["approval-required", "full-access"] },
  };
  const commands = [
    "create",
    "claim",
    "dispatch",
    "attach",
    "verify",
    "integrate",
    "reclaim",
    "run",
    "revoke",
    "revise",
    "status",
    "events",
    "issues",
  ] as const;
  const fields: Record<(typeof commands)[number], { required: string[]; optional: string[] }> = {
    create: {
      required: ["repo", "base", "oracle", "instructions"],
      optional: ["project", "title"],
    },
    claim: { required: ["owner"], optional: [] },
    dispatch: { required: ["runtimeMode"], optional: [] },
    attach: {
      required: ["role", "modelSelection", "runtimeMode", "instructions"],
      optional: ["preset"],
    },
    verify: { required: [], optional: ["attempt"] },
    integrate: { required: [], optional: ["attempt"] },
    reclaim: { required: [], optional: ["attempt", "thread"] },
    run: { required: ["runtimeMode", "wait_seconds"], optional: [] },
    revoke: { required: ["reason"], optional: [] },
    revise: { required: ["spec_rev"], optional: [] },
    status: { required: [], optional: [] },
    events: { required: [], optional: [] },
    issues: { required: [], optional: ["thread"] },
  };
  const tools: ToolEntry[] = commands.map((command) => {
    const read = ["status", "events", "issues"].includes(command);
    return {
      requiredCapability: read ? "a2a:read" : "a2a:operate",
      requiresActiveTurn: !read,
      definition: {
        name: `a2a_${command}`,
        description: read
          ? `Read a2a ${command} for the supplied task.`
          : `Execute a2a ${command} through the gate. Supply the task and the command arguments. An active turn is required.`,
        annotations: read ? READ_ONLY_TOOL_ANNOTATIONS : WRITE_TOOL_ANNOTATIONS,
        inputSchema: {
          type: "object",
          required: ["task", ...fields[command].required],
          properties: Object.fromEntries(
            ["task", ...fields[command].required, ...fields[command].optional].map((field) => [
              field,
              properties[field as keyof typeof properties],
            ]),
          ),
          additionalProperties: false,
        },
      },
      handler: (args, context) =>
        Effect.gen(function* () {
          const request = yield* Schema.decodeUnknownEffect(A2AGateRequest)({ ...args, command });
          const result = yield* Effect.promise(() => gates.call(request, caller(context)));
          return {
            ...mcpToolResultJson(result),
            ...(!result.ok ? { isError: true as const } : {}),
          };
        }).pipe(
          Effect.catchTag("SchemaError", (error) =>
            Effect.succeed({
              ...mcpToolResultJson({ ok: false, error: "invalid_request", details: String(error) }),
              isError: true as const,
            }),
          ),
        ),
    };
  });
  const inboxProperties = {
    to: { type: "string" },
    kind: {
      type: "string",
      enum: [
        "assign",
        "revise",
        "cancel",
        "stop",
        "report",
        "needs-decision",
        "issue",
        "disposition",
        "answer",
        "ack",
      ],
    },
    reply_to: { type: ["string", "null"] },
    refs: { type: "array", items: { type: "string" } },
    body: { type: "string" },
    title: { type: "string" },
    blocking: { type: "boolean" },
    action: {
      type: "string",
      enum: ["close", "dismiss", "forward", "snooze", "reopen", "needs-user", "delivered"],
    },
    reason: { type: "string" },
    basis: { type: "string" },
    bundle_id: { type: "string" },
  };
  for (const command of ["inbox_send", "inbox_list", "inbox_ack"] as const) {
    const read = command === "inbox_list";
    tools.push({
      requiredCapability: "a2a:inbox",
      requiresActiveTurn: !read,
      definition: {
        name: `a2a_${command}`,
        description: read
          ? "Read your unconfirmed inbox entries. Your credential supplies the recipient role."
          : command === "inbox_ack"
            ? "Append an acknowledgement for one received entry. Supply its id. An acknowledgement is terminal."
            : "Append an inbox entry and request one wake message. Supply kind, to, and body. Your credential supplies the sender.",
        annotations: read ? READ_ONLY_TOOL_ANNOTATIONS : WRITE_TOOL_ANNOTATIONS,
        inputSchema: {
          type: "object",
          properties:
            command === "inbox_send"
              ? inboxProperties
              : command === "inbox_ack"
                ? { id: { type: "string" }, body: { type: "string" } }
                : {},
          required:
            command === "inbox_send"
              ? ["kind", "to", "body"]
              : command === "inbox_ack"
                ? ["id"]
                : [],
          additionalProperties: false,
        },
      },
      handler: (args, context) =>
        Effect.gen(function* () {
          const request = yield* Schema.decodeUnknownEffect(A2AInboxRequest)({ ...args, command });
          const result = yield* Effect.promise(() => gates.call(request, caller(context)));
          return {
            ...mcpToolResultJson(result),
            ...(!result.ok ? { isError: true as const } : {}),
          };
        }).pipe(
          Effect.catchTag("SchemaError", (error) =>
            Effect.succeed({
              ...mcpToolResultJson({ ok: false, error: "invalid_request", details: String(error) }),
              isError: true as const,
            }),
          ),
        ),
    });
  }
  tools.push({
    requiredCapability: "a2a:stop",
    requiresActiveTurn: true,
    definition: {
      name: "a2a_stop",
      description:
        "Request an interrupt of one gate-owned worker, reviewer, or monitor. Supply thread and stop_id. The executor must leave that stop entry unacknowledged for more than two minutes. This tool does not reclaim, archive, verify, or integrate.",
      annotations: WRITE_TOOL_ANNOTATIONS,
      inputSchema: {
        type: "object",
        required: ["thread", "stop_id"],
        properties: { thread: { type: "string" }, stop_id: { type: "string" } },
        additionalProperties: false,
      },
    },
    handler: (args, context) =>
      Effect.gen(function* () {
        const request = yield* Schema.decodeUnknownEffect(A2AStopRequest)({
          ...args,
          command: "stop",
        });
        // The required stop capability grants this tool's narrow authority.
        // An additional operate capability must not shadow it in projection.
        const result = yield* Effect.promise(() =>
          gates.call(request, { ...caller(context), address: "ideation" }),
        );
        return { ...mcpToolResultJson(result), ...(!result.ok ? { isError: true as const } : {}) };
      }).pipe(
        Effect.catchTag("SchemaError", (error) =>
          Effect.succeed({
            ...mcpToolResultJson({ ok: false, error: "invalid_request", details: String(error) }),
            isError: true as const,
          }),
        ),
      ),
  });
  return tools;
}
