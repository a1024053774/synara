import { randomUUID } from "node:crypto";
import type { A2AGates } from "@synara/a2a-gates";
import type {
  A2AUserInput,
  OrchestrationCommand,
  OrchestrationPrepareQuitResumeInput,
} from "@synara/contracts";
import { Effect } from "effect";
import type { OrchestrationEngineShape } from "../orchestration/Services/OrchestrationEngine";

/** Enumerated channel shape, never a classification of the text's meaning. */
export function userCommandInput(
  gates: A2AGates,
  command: OrchestrationCommand,
  project?: string,
): A2AUserInput | undefined {
  if (command.commandId.startsWith("a2a:")) return;
  let form: A2AUserInput["form"];
  switch (command.type) {
    case "thread.approval.respond":
      form =
        command.decision === "decline" || command.decision === "cancel" ? "denial" : "approval";
      break;
    case "thread.user-input.respond":
      form = "answer";
      break;
    case "thread.turn.interrupt":
    case "thread.session.stop":
    case "thread.task.stop":
    case "thread.archive":
    case "thread.unarchive":
      form = "action";
      break;
    default:
      return;
  }
  const request = "requestId" in command ? command.requestId : null;
  return {
    id: randomUUID(),
    schema: 1,
    form,
    text: "",
    target: {
      ...gates.userInputTarget(command.threadId, project),
      turn: "turnId" in command ? (command.turnId ?? null) : null,
      request,
    },
    channel: command.origin === "ui-derived" ? "ui-derived" : "ws-rpc",
    reply_to: request,
    source_ref: { command_id: command.commandId, rpc: "orchestration.dispatchCommand" },
    content: command,
    certainty: "observed",
    created_at: "createdAt" in command ? command.createdAt : new Date().toISOString(),
  };
}

/** Register before admission. A failed input write cannot lose the RPC's source on replay. */
export const recordUserCommand = Effect.fn("a2a.recordUserCommand")(function* (
  gates: A2AGates,
  engine: OrchestrationEngineShape,
  command: OrchestrationCommand,
) {
  const model = yield* engine.getReadModel();
  const project =
    "threadId" in command
      ? model.threads.find((thread) => thread.id === command.threadId)?.projectId
      : undefined;
  const input = userCommandInput(gates, command, project);
  if (!input) return;
  const result = yield* Effect.try({
    try: () => {
      gates.registerUserInputCommand(command.commandId, input);
      gates.appendUserInput(input, `rpc:${command.commandId}`);
    },
    catch: (error) => error,
  }).pipe(Effect.result);
  if (result._tag === "Failure") {
    if (input.target.attempt) {
      gates.setUserInputObserverStatus("failed", {
        thread_id: input.target.thread,
        reason: String(result.failure),
      });
      return yield* Effect.fail(result.failure);
    }
    gates.deferUserInput(command.commandId, input);
    yield* Effect.logError("a2a user input recording failed; replay required", {
      command_id: command.commandId,
      reason: String(result.failure),
    });
  }
});

export const recordQuitResumeInput = Effect.fn("a2a.recordQuitResumeInput")(function* (
  gates: A2AGates,
  request: OrchestrationPrepareQuitResumeInput,
) {
  const id = randomUUID();
  for (const thread of new Set(request.threadIds)) {
    const input: A2AUserInput = {
      id: randomUUID(),
      schema: 1,
      form: "action",
      text: "",
      target: gates.userInputTarget(thread),
      channel: "ui-derived",
      reply_to: null,
      source_ref: { command_id: id, rpc: "orchestration.prepareQuitResume" },
      content: { type: "orchestration.prepareQuitResume", threadIds: request.threadIds },
      certainty: "observed",
      created_at: new Date().toISOString(),
    };
    const commandId = `quit:${id}:${thread}`;
    const result = yield* Effect.try({
      try: () => {
        gates.registerUserInputCommand(commandId, input);
        gates.appendUserInput(input, `rpc:${commandId}`);
      },
      catch: (error) => error,
    }).pipe(Effect.result);
    if (result._tag === "Failure") {
      if (input.target.attempt) {
        gates.setUserInputObserverStatus("failed", {
          thread_id: thread,
          reason: String(result.failure),
        });
        return yield* Effect.fail(result.failure);
      }
      gates.deferUserInput(commandId, input);
      yield* Effect.logError("a2a quit resume recording failed", {
        reason: String(result.failure),
      });
    }
  }
});
