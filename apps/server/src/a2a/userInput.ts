import { randomUUID } from "node:crypto";
import type { A2AGates } from "@synara/a2a-gates";
import type {
  A2AUserInput,
  OrchestrationCommand,
  OrchestrationPrepareQuitResumeInput,
  OrchestrationReconcileProviderDeliveryInput,
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
    case "thread.message.edit-and-resend":
    case "thread.checkpoint.revert":
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
      message: "messageId" in command ? command.messageId : null,
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

/** The same ingress and failure policy serves all three WS observation points. */
const persistUserInput = Effect.fn("a2a.persistUserInput")(function* (
  gates: A2AGates,
  commandId: string,
  input: A2AUserInput,
) {
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
        thread_id: input.target.thread,
        reason: String(result.failure),
      });
      return yield* Effect.fail(result.failure);
    }
    gates.deferUserInput(commandId, input);
    yield* Effect.logError("a2a user input recording failed; replay required", {
      command_id: commandId,
      reason: String(result.failure),
    });
  }
});

/** Register before admission so replay retains the RPC observation's source. */
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
  if (input) yield* persistUserInput(gates, command.commandId, input);
});

export const recordReconcileInput = Effect.fn("a2a.recordReconcileInput")(function* (
  gates: A2AGates,
  engine: OrchestrationEngineShape,
  request: OrchestrationReconcileProviderDeliveryInput,
) {
  const model = yield* engine.getReadModel();
  const project = model.threads.find((thread) => thread.id === request.threadId)?.projectId;
  // This RPC has no command ID. Each server receipt is a distinct observation,
  // including a repeated request that the business CAS rejects as stale.
  const commandId = `reconcile:${randomUUID()}`;
  yield* persistUserInput(gates, commandId, {
    id: randomUUID(),
    schema: 1,
    form: "action",
    text: "",
    target: {
      ...gates.userInputTarget(request.threadId, project),
      eventSequence: request.eventSequence,
    },
    channel: "ws-rpc",
    reply_to: null,
    source_ref: { command_id: commandId, rpc: "orchestration.reconcileProviderDelivery" },
    content: { type: "orchestration.reconcileProviderDelivery", ...request },
    certainty: "observed",
    created_at: new Date().toISOString(),
  });
});

export const recordQuitResumeInput = Effect.fn("a2a.recordQuitResumeInput")(function* (
  gates: A2AGates,
  engine: OrchestrationEngineShape,
  request: OrchestrationPrepareQuitResumeInput,
) {
  const id = randomUUID();
  const model = yield* engine.getReadModel();
  for (const thread of new Set(request.threadIds)) {
    const input: A2AUserInput = {
      id: randomUUID(),
      schema: 1,
      form: "action",
      text: "",
      target: gates.userInputTarget(
        thread,
        model.threads.find((item) => item.id === thread)?.projectId,
      ),
      channel: "ui-derived",
      reply_to: null,
      source_ref: { command_id: id, rpc: "orchestration.prepareQuitResume" },
      content: { type: "orchestration.prepareQuitResume", threadIds: request.threadIds },
      certainty: "observed",
      created_at: new Date().toISOString(),
    };
    const commandId = `quit:${id}:${thread}`;
    yield* persistUserInput(gates, commandId, input);
  }
});
