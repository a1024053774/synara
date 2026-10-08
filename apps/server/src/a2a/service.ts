import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { A2AGates, Refusal } from "@synara/a2a-gates";
import { CommandId, MessageId, ProjectId, ThreadId, type ModelSelection } from "@synara/contracts";
import { Effect, Layer, Option, ServiceMap } from "effect";
import { installHumanInputRecording, readManagedThread } from "./orchestration";
import { ServerConfig } from "../config";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery";
import { ProviderService } from "../provider/Services/ProviderService";

export class A2AGateService extends ServiceMap.Service<A2AGateService, A2AGates>()("a2a/gates") {}

export const A2AGateServiceLive = Layer.effect(
  A2AGateService,
  Effect.gen(function* () {
    const config = yield* ServerConfig;
    const engine = yield* OrchestrationEngineService;
    const query = yield* ProjectionSnapshotQuery;
    const providers = yield* ProviderService;
    const commandId = () => CommandId.makeUnsafe(`a2a:${randomUUID()}`);
    const modelSelection: ModelSelection = {
      provider: "codex",
      model: "gpt-6.1-sol",
      options: { reasoningEffort: "xhigh", fastMode: true },
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
            title: "a2a pagination",
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
      readThread: async (thread) => {
        const value = await Effect.runPromise(
          query.getThreadShellById(ThreadId.makeUnsafe(thread)),
        );
        if (Option.isNone(value)) throw new Error("thread_identity_unknown");
        const shell = value.value;
        if (shell.id !== thread) throw new Refusal("identity_conflict");
        const sessions = await Effect.runPromise(providers.listSessions());
        return readManagedThread(shell, sessions);
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
      },
      archiveThread: async (thread) => {
        await Effect.runPromise(
          engine.dispatch({
            type: "thread.archive",
            commandId: commandId(),
            threadId: ThreadId.makeUnsafe(thread),
          }),
        );
      },
    });
    yield* Effect.addFinalizer(() => Effect.sync(() => core.close()));
    yield* installHumanInputRecording(core, engine);
    return core;
  }),
);
