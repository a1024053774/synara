import { Refusal, type A2AGates, type GateRuntime } from "@synara/a2a-gates";
import type {
  OrchestrationEvent,
  OrchestrationThreadShell,
  ProviderSession,
} from "@synara/contracts";
import { Cause, Effect, Exit, Option, Stream } from "effect";
import type { OrchestrationEngineShape } from "../orchestration/Services/OrchestrationEngine";

export function readManagedThread(
  shell: OrchestrationThreadShell,
  sessions: ReadonlyArray<ProviderSession>,
  workspace = shell.worktreePath ?? "",
): Awaited<ReturnType<GateRuntime["readThread"]>> {
  const matches = sessions.filter((session) => session.threadId === shell.id);
  if (matches.length > 1) throw new Refusal("identity_conflict", matches);
  const active = matches[0];
  if (active && (active.cwd !== workspace || active.provider !== shell.modelSelection.provider))
    throw new Refusal("identity_conflict", { shell, active });
  if (shell.session?.status === "interrupted" && active)
    throw new Refusal("run_external_unknown", { shell, active });
  const error = shell.session?.status === "error" || active?.status === "error";
  const turn = shell.session?.activeTurnId ?? shell.latestTurn?.turnId ?? null;
  const running =
    shell.latestTurn?.state === "running" ||
    (shell.session?.status === "running" && shell.session.activeTurnId !== null) ||
    (!turn && Boolean(active?.activeTurnId));
  // A native turn can precede its projection. Keep it unbound until the shell
  // supplies the turn; the existing run deadline bounds observation, and submit
  // still requires that projected turn to match the caller.
  if (turn && active?.activeTurnId && active.activeTurnId !== turn)
    throw new Refusal("identity_conflict", { shell, active });
  if (running && !active?.activeTurnId)
    throw new Refusal("run_external_unknown", { shell, active });
  return {
    workspace,
    provider: shell.session?.providerName ?? shell.modelSelection.provider,
    turn,
    running,
    blocked:
      shell.hasPendingApprovals === true ||
      shell.hasPendingUserInput === true ||
      shell.hasActionableProposedPlan === true,
    ...(error
      ? {
          error: {
            providerPresent: active !== undefined,
            activeTurn:
              shell.session?.activeTurnId ??
              active?.activeTurnId ??
              (shell.latestTurn?.state === "running" ? shell.latestTurn.turnId : null),
          },
        }
      : {}),
    // An interrupted thread with no provider runtime cannot complete a run,
    // but the gate can stop/archive it through the same locked reclaim path.
    stopped:
      !active && (shell.session?.status === "stopped" || shell.session?.status === "interrupted"),
    archived: shell.archivedAt !== null,
  };
}

/** Observe authoritative server provenance. Input never delivers a candidate. */
export function recordUserMessage(
  gates: A2AGates,
  event: OrchestrationEvent,
  project?: string | null,
  answer?: { request: string; content: unknown },
): void {
  if (event.type !== "thread.message-sent") return;
  const message = event.payload;
  if (
    message.role !== "user" ||
    message.dispatchOrigin !== "user" ||
    event.commandId?.startsWith("a2a:")
  )
    return;
  gates.recordUserInput({
    thread_id: message.threadId,
    turn_id: message.turnId ?? null,
    message_id: message.messageId,
    event_id: event.eventId,
    source_sequence: event.sequence,
    created_at: message.createdAt,
    text: message.text,
    dispatch_origin: "user",
    project_id: project ?? null,
    ...(answer ? { answer } : {}),
    ...(message.attachments
      ? {
          attachments: message.attachments.map((attachment) => ({
            id: attachment.id,
            type: attachment.type,
            ...(attachment.type === "assistant-selection"
              ? { message_id: attachment.assistantMessageId }
              : {}),
          })),
        }
      : {}),
  });
}

export const installUserInputRecording = Effect.fn("a2a.installUserInputRecording")(function* (
  gates: A2AGates,
  engine: OrchestrationEngineShape,
) {
  gates.setUserInputObserverStatus("starting");
  const events = yield* engine.subscribeDomainEvents;
  const highWater = yield* engine.getEventHighWaterSequence;
  const checkpoint = gates.userInputCheckpoint();
  const gaps = new Map<string, { first: OrchestrationEvent; last: number }>();
  let replaying = true;
  let replayFailed = false;
  const replayCommandTypes = new Set([
    "thread.approval-response-requested",
    "thread.user-input-response-requested",
    "thread.turn-interrupt-requested",
    "thread.session-stop-requested",
    "thread.task-stop-requested",
    "thread.archived",
    "thread.unarchived",
  ]);
  const projects = new Map<string, string>();
  const answers = new Map<string, { request: string; content: unknown }>();
  const record = (event: OrchestrationEvent) =>
    Effect.gen(function* () {
      if (event.type === "thread.async-user-input-answered") {
        answers.set(event.payload.response.messageId, {
          request: event.payload.messageId,
          content: event.payload.response.answers,
        });
      }
      if (event.type === "thread.created")
        projects.set(event.payload.threadId, event.payload.projectId);
      const project = projects.get(event.aggregateId);
      const failure = yield* Effect.try({
        try: () => {
          recordUserMessage(
            gates,
            event,
            project,
            event.type === "thread.message-sent" ? answers.get(event.payload.messageId) : undefined,
          );
          gates.flushDeferredUserInputs();
          const registered = event.commandId ? gates.userInputCommand(event.commandId) : undefined;
          if (
            replaying &&
            checkpoint !== undefined &&
            event.sequence > checkpoint &&
            replayCommandTypes.has(event.type) &&
            !registered &&
            !event.commandId?.startsWith("a2a:")
          ) {
            const previous = gaps.get(event.aggregateId);
            gaps.set(event.aggregateId, { first: previous?.first ?? event, last: event.sequence });
          }
          if (registered && event.type !== "thread.message-sent") {
            gates.appendUserInput(
              {
                ...registered,
                source_ref: {
                  ...registered.source_ref,
                  event_id: event.eventId,
                  source_sequence: event.sequence,
                },
              },
              `rpc:${event.commandId}`,
            );
          }
          if (!replaying) gates.advanceUserInputCheckpoint(event.sequence);
        },
        catch: (cause) => ({
          event_id: event.eventId,
          source_sequence: event.sequence,
          thread_id: event.aggregateId,
          reason: String(cause),
        }),
      }).pipe(Effect.result);
      if (failure._tag === "Failure") {
        if (replaying) replayFailed = true;
        // Managed failures retain the existing global fail-closed latch. Other
        // failures leave business commands available; startup replays the journal.
        if (gates.userInputTarget(event.aggregateId).attempt) {
          gates.setUserInputObserverStatus("failed", failure.failure);
        }
        yield* Effect.logError("a2a user input recording failed", failure.failure);
      }
    });
  yield* Stream.runForEach(engine.readEventsThrough(0, highWater), record);
  for (const [thread, { first, last }] of gaps) {
    const recovered = yield* Effect.try({
      try: () =>
        gates.appendUserInput(
          {
            id: `gap:${first.eventId}:${last}`,
            schema: 1,
            form: "gap",
            text: "",
            target: gates.userInputTarget(thread, projects.get(thread)),
            channel: "ws-rpc",
            reply_to: null,
            source_ref: { event_id: first.eventId, source_sequence: first.sequence },
            certainty: "observed",
            created_at: first.occurredAt,
            content: {
              from_sequence: first.sequence,
              through_sequence: last,
              reason:
                "RPC origin unavailable after recorder outage; these events may be user, ui-derived or internal commands",
            },
          },
          `gap:${first.eventId}:${last}`,
        ),
      catch: (error) => error,
    }).pipe(Effect.result);
    if (recovered._tag === "Failure") {
      replayFailed = true;
      yield* Effect.logError("a2a input gap recovery failed", {
        reason: String(recovered.failure),
      });
    }
  }
  if (!replayFailed) gates.advanceUserInputCheckpoint(highWater);
  replaying = false;
  // prepareQuitResume has no command event of its own. Its authoritative entry
  // receipts also recover any write interrupted after registration.
  for (const { commandId, input } of gates.userInputCommands()) {
    const recovered = yield* Effect.try({
      try: () => gates.appendUserInput(input, `rpc:${commandId}`),
      catch: (error) => error,
    }).pipe(Effect.result);
    if (recovered._tag === "Failure") {
      if (input.target.attempt)
        gates.setUserInputObserverStatus("failed", {
          thread_id: input.target.thread,
          reason: String(recovered.failure),
        });
      yield* Effect.logError("a2a input receipt recovery failed", {
        reason: String(recovered.failure),
      });
    }
  }
  yield* Effect.forkScoped(
    Stream.runForEach(events, record).pipe(
      Effect.onExit((exit) => {
        if (Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause))
          return Effect.sync(() => gates.setUserInputObserverStatus("stopped"));
        const failure = Exit.isFailure(exit)
          ? Option.getOrUndefined(Cause.findErrorOption(exit.cause))
          : undefined;
        return Effect.sync(() =>
          gates.setUserInputObserverStatus(
            "failed",
            failure ?? {
              reason: Exit.isFailure(exit) ? Cause.pretty(exit.cause) : "User input stream ended",
            },
          ),
        );
      }),
    ),
  );
  gates.setUserInputObserverStatus("healthy");
});
