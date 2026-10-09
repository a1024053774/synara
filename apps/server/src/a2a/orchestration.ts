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
export function recordHumanMessage(gates: A2AGates, event: OrchestrationEvent): void {
  if (event.type !== "thread.message-sent") return;
  const message = event.payload;
  if (message.role !== "user" || message.dispatchOrigin !== "user") return;
  gates.recordHumanInput({
    thread_id: message.threadId,
    turn_id: message.turnId ?? null,
    message_id: message.messageId,
    event_id: event.eventId,
    source_sequence: event.sequence,
    created_at: message.createdAt,
    text: message.text,
    dispatch_origin: "user",
  });
}

export const installHumanInputRecording = Effect.fn("a2a.installHumanInputRecording")(function* (
  gates: A2AGates,
  engine: OrchestrationEngineShape,
) {
  // Attach before replay; the core deduplicates overlapping event IDs. Replay
  // also records messages committed while this service was not running.
  gates.setHumanInputObserverStatus("starting");
  const events = yield* engine.subscribeDomainEvents;
  const highWater = yield* engine.getEventHighWaterSequence;
  const record = (event: OrchestrationEvent) =>
    Effect.try({
      try: () => recordHumanMessage(gates, event),
      catch: (cause) => ({
        event_id: event.eventId,
        source_sequence: event.sequence,
        ...(event.type === "thread.message-sent"
          ? {
              thread_id: event.payload.threadId,
              message_id: event.payload.messageId,
            }
          : {}),
        reason: String(cause),
      }),
    });
  yield* Stream.runForEach(engine.readEventsThrough(0, highWater), record);
  yield* Effect.forkScoped(
    Stream.runForEach(events, record).pipe(
      Effect.onExit((exit) => {
        if (Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)) {
          return Effect.sync(() => gates.setHumanInputObserverStatus("stopped"));
        }
        const failure = Exit.isFailure(exit)
          ? Option.getOrUndefined(Cause.findErrorOption(exit.cause))
          : undefined;
        const details = failure ?? {
          reason: Exit.isFailure(exit) ? Cause.pretty(exit.cause) : "Human input stream ended",
        };
        return Effect.sync(() => gates.setHumanInputObserverStatus("failed", details)).pipe(
          Effect.andThen(Effect.logError("a2a human input observer failed", details)),
        );
      }),
    ),
  );
  gates.setHumanInputObserverStatus("healthy");
});
