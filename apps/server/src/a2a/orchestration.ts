import { Refusal, type A2AGates, type GateRuntime } from "@synara/a2a-gates";
import type {
  OrchestrationEvent,
  OrchestrationThreadShell,
  ProviderSession,
} from "@synara/contracts";
import { Effect, Stream } from "effect";
import type { OrchestrationEngineShape } from "../orchestration/Services/OrchestrationEngine";

export function readManagedThread(
  shell: OrchestrationThreadShell,
  sessions: ReadonlyArray<ProviderSession>,
): Awaited<ReturnType<GateRuntime["readThread"]>> {
  const matches = sessions.filter((session) => session.threadId === shell.id);
  if (matches.length > 1) throw new Refusal("identity_conflict", matches);
  const active = matches[0];
  if (
    active &&
    (active.cwd !== shell.worktreePath || active.provider !== shell.modelSelection.provider)
  )
    throw new Refusal("identity_conflict", { shell, active });
  if (
    shell.session?.status === "error" ||
    shell.session?.status === "interrupted" ||
    active?.status === "error"
  )
    throw new Refusal("run_external_unknown", { shell, active });
  const turn = shell.session?.activeTurnId ?? shell.latestTurn?.turnId ?? null;
  const running =
    shell.latestTurn?.state === "running" ||
    (shell.session?.status === "running" && shell.session.activeTurnId !== null);
  if (active?.activeTurnId && active.activeTurnId !== turn)
    throw new Refusal("identity_conflict", { shell, active });
  if (running && !active?.activeTurnId)
    throw new Refusal("run_external_unknown", { shell, active });
  return {
    workspace: shell.worktreePath ?? "",
    provider: shell.session?.providerName ?? shell.modelSelection.provider,
    turn,
    running,
    blocked: shell.hasPendingApprovals === true || shell.hasPendingUserInput === true,
    stopped: shell.session?.status === "stopped" && !active,
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
  const events = yield* engine.subscribeDomainEvents;
  const highWater = yield* engine.getEventHighWaterSequence;
  const record = (event: OrchestrationEvent) =>
    Effect.try({
      try: () => recordHumanMessage(gates, event),
      catch: (cause) => new Error(`a2a message recording failed for ${event.eventId}`, { cause }),
    });
  yield* Stream.runForEach(engine.readEventsThrough(0, highWater), record);
  yield* Effect.forkScoped(
    Stream.runForEach(events, record).pipe(
      Effect.tapError((error) => Effect.logError("a2a human input observer failed", error)),
    ),
  );
});
