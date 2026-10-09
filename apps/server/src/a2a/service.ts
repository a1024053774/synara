import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { A2AGates, Refusal } from "@synara/a2a-gates";
import {
  CommandId,
  MessageId,
  ProjectId,
  ThreadId,
  type ModelSelection,
  type A2ARun,
} from "@synara/contracts";
import { Effect, Layer, Option, ServiceMap } from "effect";
import { installHumanInputRecording, readManagedThread } from "./orchestration";
import { ServerConfig } from "../config";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery";
import { ProviderService } from "../provider/Services/ProviderService";
import { ProviderRuntimeIngestionService } from "../orchestration/Services/ProviderRuntimeIngestion";
import { ProviderCommandReactor } from "../orchestration/Services/ProviderCommandReactor";

export class A2AGateService extends ServiceMap.Service<A2AGateService, A2AGates>()("a2a/gates") {}

export const A2AGateServiceLive = Layer.effect(
  A2AGateService,
  Effect.gen(function* () {
    const config = yield* ServerConfig;
    const engine = yield* OrchestrationEngineService;
    const query = yield* ProjectionSnapshotQuery;
    const providers = yield* ProviderService;
    const ingestion = yield* ProviderRuntimeIngestionService;
    const providerCommands = yield* ProviderCommandReactor;
    const commandId = () => CommandId.makeUnsafe(`a2a:${randomUUID()}`);
    const modelSelection: ModelSelection = {
      provider: "codex",
      model: "gpt-6.1-sol",
      options: { reasoningEffort: "xhigh", fastMode: true },
    };
    // Runtime events must reach their ingestion ACK before a domain high-water
    // can fence the snapshot. The snapshot cursor is the minimum required
    // projector cursor; reading the journal alone is not settlement evidence.
    const settleProjection = Effect.gen(function* () {
      yield* ingestion.drain;
      const fence = yield* engine.getEventHighWaterSequence;
      const projected = yield* query.getSnapshotSequence();
      if (projected.snapshotSequence < fence)
        throw new Refusal("run_external_unknown", { fence, projected });
    });
    const bounded = async <A>(thread: string, operation: Effect.Effect<A, unknown>) => {
      // The gate's append-only phase record owns the deadline. Keep the native
      // boundary inside the same submit/reclaim window without changing the
      // GateRuntime contract or starting another observation/retry loop.
      let millis = 45_000;
      let timeoutCode = "run_external_unknown";
      const task = core.taskForThread(thread);
      if (task) {
        const result = await core.call({ command: "events", task: task.task_id });
        const phase = result.events?.findLast(
          (event) =>
            ["run_bound", "run_phase", "run_finished"].includes(event.type) &&
            (event.details as A2ARun).thread_id === thread,
        );
        const run = phase?.details as A2ARun | undefined;
        if (phase && run?.outcome === "running") {
          if (run.phase === "waiting_submit") {
            const left = Date.parse(phase.time) + run.wait_seconds * 1000 - Date.now();
            // An expired submit window enters the gate's existing 60-second
            // idle cleanup. It cannot resume verification or integration.
            millis = Math.max(0, left > 0 ? left : left + 60_000);
            timeoutCode = left > 0 ? "run_deadline" : "run_reclaim_deadline";
          } else if (run.phase === "reclaiming") {
            millis = Math.max(0, Date.parse(phase.time) + 60_000 - Date.now());
            timeoutCode = "run_reclaim_deadline";
          }
        }
      }
      try {
        const value = await Effect.runPromise(
          operation.pipe(Effect.timeoutOption(`${millis} millis`)),
        );
        if (Option.isNone(value)) throw new Refusal(timeoutCode, { thread, millis });
        return value.value;
      } catch (error) {
        if (error instanceof Refusal) throw error;
        throw new Refusal("run_external_unknown", String(error));
      }
    };
    const core = new A2AGates(join(config.stateDir, "a2a-gates"), {
      ensureProject: async (project, repo) => {
        const shell = await Effect.runPromise(
          query.getProjectShellById(ProjectId.makeUnsafe(project)),
        );
        if (Option.isSome(shell)) {
          if (shell.value.workspaceRoot !== repo) throw new Error("project_repo_mismatch");
          return;
        }
        await Effect.runPromise(
          engine.dispatch({
            type: "project.create",
            commandId: commandId(),
            projectId: ProjectId.makeUnsafe(project),
            title: project,
            workspaceRoot: repo,
            createdAt: new Date().toISOString(),
          }),
        );
      },
      createThread: async (task, attempt) => {
        await Effect.runPromise(
          engine.dispatch({
            type: "thread.create",
            commandId: commandId(),
            threadId: ThreadId.makeUnsafe(attempt.thread_id),
            projectId: ProjectId.makeUnsafe(task.project_id),
            title: task.task_id,
            modelSelection,
            runtimeMode: attempt.runtime_mode,
            interactionMode: "default",
            envMode: "worktree",
            branch: null,
            worktreePath: attempt.workspace,
            createdAt: new Date().toISOString(),
          }),
        );
      },
      startThread: async (_task, attempt, prompt) => {
        await Effect.runPromise(
          engine.dispatch({
            type: "thread.turn.start",
            commandId: commandId(),
            threadId: ThreadId.makeUnsafe(attempt.thread_id),
            message: {
              messageId: MessageId.makeUnsafe(randomUUID()),
              role: "user",
              text: prompt,
              attachments: [],
            },
            modelSelection,
            runtimeMode: attempt.runtime_mode,
            interactionMode: "default",
            dispatchOrigin: "agent",
            createdAt: new Date().toISOString(),
          }),
        );
      },
      createAttachedThread: async (task, attachment, prompt) => {
        const threadId = ThreadId.makeUnsafe(attachment.thread_id);
        await Effect.runPromise(
          engine.dispatch({
            type: "thread.create",
            commandId: commandId(),
            threadId,
            projectId: ProjectId.makeUnsafe(task.project_id),
            title: `${attachment.role} · ${task.title ?? task.task_id}`,
            modelSelection: attachment.modelSelection,
            runtimeMode: attachment.runtime_mode,
            interactionMode: "default",
            envMode: "local",
            branch: null,
            worktreePath: null,
            createdAt: new Date().toISOString(),
          }),
        );
        await Effect.runPromise(
          engine.dispatch({
            type: "thread.turn.start",
            commandId: commandId(),
            threadId,
            message: {
              messageId: MessageId.makeUnsafe(randomUUID()),
              role: "user",
              text: prompt,
              attachments: [],
            },
            modelSelection: attachment.modelSelection,
            runtimeMode: attachment.runtime_mode,
            interactionMode: "default",
            dispatchOrigin: "agent",
            createdAt: new Date().toISOString(),
          }),
        );
      },
      readThread: async (thread) => {
        const { value, sessions, project } = await bounded(
          thread,
          Effect.gen(function* () {
            const sessions = yield* providers.listSessions();
            yield* settleProjection;
            const value = yield* query.getThreadShellById(ThreadId.makeUnsafe(thread));
            const project =
              Option.isSome(value) && value.value.worktreePath === null
                ? yield* query.getProjectShellById(value.value.projectId)
                : Option.none();
            return { value, sessions, project };
          }),
        );
        if (Option.isNone(value))
          throw new Refusal("run_external_unknown", "thread_identity_unknown");
        const shell = value.value;
        if (shell.id !== thread) throw new Refusal("identity_conflict");
        if (shell.worktreePath === null && Option.isNone(project))
          throw new Refusal("run_external_unknown", "project_identity_unknown");
        return readManagedThread(
          shell,
          sessions,
          shell.worktreePath ?? (Option.isSome(project) ? project.value.workspaceRoot : ""),
        );
      },
      sendUserAnswer: async (thread, messageId, text) => {
        const value = await Effect.runPromise(
          query.getThreadShellById(ThreadId.makeUnsafe(thread)),
        );
        if (Option.isNone(value) || value.value.archivedAt !== null)
          throw new Refusal("session_ended");
        const shell = value.value;
        await Effect.runPromise(
          engine.dispatch({
            type: "thread.turn.start",
            commandId: CommandId.makeUnsafe(`a2a:answer:${messageId}`),
            threadId: shell.id,
            message: {
              messageId: MessageId.makeUnsafe(messageId),
              role: "user",
              text,
              attachments: [],
            },
            modelSelection: shell.modelSelection,
            runtimeMode: shell.runtimeMode,
            interactionMode: shell.interactionMode,
            dispatchOrigin: "user",
            dispatchMode: "queue",
            createdAt: new Date().toISOString(),
          }),
        );
      },
      stopThread: async (thread) => {
        await Effect.runPromise(providers.stopSession({ threadId: ThreadId.makeUnsafe(thread) }));
        await Effect.runPromise(
          engine.dispatch({
            type: "thread.session.stop",
            commandId: commandId(),
            threadId: ThreadId.makeUnsafe(thread),
            createdAt: new Date().toISOString(),
          }),
        );
        // A stop receipt records the intent. Its provider consumer must ACK
        // the actual stop and emit the session-set fact before core readback.
        await bounded(thread, providerCommands.drain.pipe(Effect.andThen(settleProjection)));
      },
      archiveThread: async (thread) => {
        await Effect.runPromise(
          engine.dispatch({
            type: "thread.archive",
            commandId: commandId(),
            threadId: ThreadId.makeUnsafe(thread),
          }),
        );
        await bounded(thread, providerCommands.drain.pipe(Effect.andThen(settleProjection)));
      },
    });
    yield* Effect.addFinalizer(() => Effect.sync(() => core.close()));
    yield* installHumanInputRecording(core, engine);
    return core;
  }),
);
