import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OrchestrationThreadShell, ProviderSession } from "@synara/contracts";
import { Refusal } from "@synara/a2a-gates";
import { Effect, Layer, ManagedRuntime, Option, Stream } from "effect";
import { describe, it } from "vitest";
import { ServerConfig } from "../config";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery";
import { ProviderService } from "../provider/Services/ProviderService";
import { A2AGateService, A2AGateServiceLive } from "./service";
import { readManagedThread } from "./orchestration";

// Only the native shell/provider boundary is controlled. The service, sole gate
// entry, operation locks, SQLite state, and fixture Git repository are real.
async function fixture(mode: "lag" | "running" | "interrupted") {
  const root = mkdtempSync(join(tmpdir(), "a2a-t039-service-"));
  const repo = join(root, "repo");
  mkdirSync(repo);
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", repo, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
    }).trim();
  git("init");
  git("config", "user.name", "T-039 controlled native boundary");
  git("config", "user.email", "fixture@example.invalid");
  writeFileSync(join(repo, "input.txt"), "Independent original\n");
  git("add", "input.txt");
  git("commit", "-m", "Independent original");
  const base = git("rev-parse", "HEAD");
  const oracle = join(root, "oracle.py");
  const marker = join(root, "oracle-ran");
  const instructions = join(root, "instructions.txt");
  writeFileSync(oracle, `from pathlib import Path\nPath(${JSON.stringify(marker)}).touch()\n`);
  writeFileSync(instructions, "Controlled thread input; no model or implicit delivery.\n");
  let shell: OrchestrationThreadShell;
  let sessions: ProviderSession[] = [];
  let releaseLag: ReturnType<typeof setTimeout> | undefined;
  const effects: string[] = [];
  const commands: unknown[] = [];
  const engine = {
    subscribeDomainEvents: Effect.succeed(Stream.never),
    getEventHighWaterSequence: Effect.succeed(0),
    readEventsThrough: () => Stream.empty,
    dispatch: (command: Record<string, any>) =>
      Effect.sync(() => {
        commands.push(command);
        if (command.type === "thread.create") {
          shell = {
            id: command.threadId,
            projectId: command.projectId,
            modelSelection: command.modelSelection,
            worktreePath: command.worktreePath,
            archivedAt: null,
            latestTurn: null,
            session: null,
            hasPendingApprovals: false,
            hasPendingUserInput: false,
          } as OrchestrationThreadShell;
        } else if (command.type === "thread.turn.start") {
          shell = {
            ...shell,
            session: {
              threadId: shell.id,
              providerName: "codex",
              status: mode === "interrupted" ? "interrupted" : "ready",
              activeTurnId: null,
            } as NonNullable<OrchestrationThreadShell["session"]>,
          };
          if (mode !== "interrupted") {
            sessions = [
              {
                threadId: shell.id,
                provider: "codex",
                status: "running",
                cwd: shell.worktreePath!,
                activeTurnId: "literal-turn-a",
                runtimeMode: "full-access",
                createdAt: "2026-10-08T00:00:00.000Z",
                updatedAt: "2026-10-08T00:00:01.000Z",
              } as ProviderSession,
            ];
          }
          if (mode === "running") {
            shell = {
              ...shell,
              session: {
                ...shell.session!,
                status: "running",
                activeTurnId: "literal-turn-a" as never,
              },
              latestTurn: { turnId: "literal-turn-a", state: "running" } as NonNullable<
                OrchestrationThreadShell["latestTurn"]
              >,
            };
          }
        } else if (command.type === "thread.session.stop") {
          effects.push("project-stopped");
          shell = {
            ...shell,
            session: { ...shell.session!, status: "stopped", activeTurnId: null },
          };
        } else if (command.type === "thread.archive") {
          effects.push("archive");
          shell = { ...shell, archivedAt: "2026-10-08T00:00:02.000Z" };
        }
      }),
  };
  const query = {
    getProjectShellById: () => Effect.succeed(Option.none()),
    getThreadShellById: () => Effect.sync(() => Option.some(structuredClone(shell))),
  };
  const provider = {
    listSessions: () => Effect.sync(() => structuredClone(sessions)),
    stopSession: () =>
      Effect.sync(() => {
        effects.push("stop");
        sessions = [];
      }),
  };
  const runtime = ManagedRuntime.make(
    A2AGateServiceLive.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.succeed(ServerConfig, { stateDir: join(root, "state") } as never),
          Layer.succeed(OrchestrationEngineService, engine as never),
          Layer.succeed(ProjectionSnapshotQuery, query as never),
          Layer.succeed(ProviderService, provider as never),
        ),
      ),
    ),
  );
  const gates = await runtime.runPromise(Effect.service(A2AGateService));
  const created = await gates.call({
    command: "create",
    task: "controlled",
    project: "controlled-project",
    repo,
    base,
    oracle,
    instructions,
  });
  assert.equal(created.ok, true, JSON.stringify(created));
  return {
    root,
    repo,
    base,
    marker,
    gates,
    effects,
    commands,
    get shell() {
      return shell;
    },
    set shell(value: OrchestrationThreadShell) {
      shell = value;
    },
    get sessions() {
      return sessions;
    },
    set sessions(value: ProviderSession[]) {
      sessions = value;
    },
    releaseAtDeadline() {
      // The provider settles after the submit deadline so existing bounded
      // cleanup can reclaim. No projection/submit is supplied during the wait.
      releaseLag = setTimeout(() => {
        sessions = [];
      }, 1500);
    },
    async dispose() {
      clearTimeout(releaseLag);
      await runtime.dispose();
    },
  };
}

describe("a2a native observation seam", () => {
  it("keeps an unprojected turn unbound and rejects delivery until projected", async () => {
    const f = await fixture("lag");
    try {
      const dispatched = await f.gates.call({
        command: "dispatch",
        task: "controlled",
        runtimeMode: "full-access",
      });
      assert.equal(dispatched.ok, true, JSON.stringify(dispatched));
      const a = dispatched.attempt!;
      assert.equal(a.turn_id, null);
      const submit = await f.gates.call(
        {
          command: "submit",
          task: "controlled",
          attempt: a.attempt_id,
          session: a.session_id,
          fence: a.fence,
          spec_rev: a.spec_rev,
          commit: f.base,
        },
        { thread: a.thread_id, turn: "literal-turn-a", assertActive: async () => {} },
      );
      assert.equal(submit.ok, false);
      const state = (await f.gates.call({ command: "status", task: "controlled" })).task!;
      assert.equal(state.candidate_commit, null);
      assert.equal(state.verification, null);
      assert.equal(state.integration_intent, null);
      assert.equal(gitRef(f.repo), f.base);
    } finally {
      await f.dispose();
    }
  });

  it("uses the existing deadline while projection remains absent without business progress", async () => {
    const f = await fixture("lag");
    try {
      f.releaseAtDeadline();
      const result = await f.gates.call({
        command: "run",
        task: "controlled",
        runtimeMode: "full-access",
        wait_seconds: 1,
      });
      assert.equal(result.error, "run_deadline", JSON.stringify(result));
      assert.equal(result.run!.outcome, "deadline");
      const events = (await f.gates.call({ command: "events", task: "controlled" })).events!;
      assert.ok(events.some((e) => e.type === "run_observed"));
      assert.ok(
        !events.some((e) =>
          ["turn_bound", "submitted", "verification_started", "integrated"].includes(e.type),
        ),
      );
      assert.equal(existsSync(f.marker), false);
      assert.equal(gitRef(f.repo), f.base);
    } finally {
      await f.dispose();
    }
  });

  it("reclaims an interrupted bound attempt through stop, archive and confirmed readback", async () => {
    const f = await fixture("running");
    try {
      const dispatched = await f.gates.call({
        command: "dispatch",
        task: "controlled",
        runtimeMode: "full-access",
      });
      assert.equal(dispatched.ok, true);
      const a = dispatched.attempt!;
      f.shell = {
        ...f.shell,
        session: { ...f.shell.session!, status: "interrupted", activeTurnId: null },
        latestTurn: { ...f.shell.latestTurn!, state: "interrupted" },
      };
      f.sessions = [];
      const result = await f.gates.call({
        command: "reclaim",
        task: "controlled",
        attempt: a.attempt_id,
      });
      assert.equal(result.ok, true, JSON.stringify(result));
      assert.deepEqual(f.effects, ["stop", "project-stopped", "archive"]);
      const events = (await f.gates.call({ command: "events", task: "controlled" })).events!;
      const reclaimed = events.find((e) => e.type === "reclaimed")!;
      assert.ok(reclaimed);
      const details = reclaimed.details as any;
      assert.equal(details.attempt.attempt_id, a.attempt_id);
      assert.equal(details.attempt.reclaimed, true);
      assert.equal(details.archived.archived, true);
      assert.equal(details.archived.stopped, true);
      assert.equal(gitRef(f.repo), f.base);
    } finally {
      await f.dispose();
    }
  });

  it("never treats an interrupted thread as a successful run", async () => {
    const f = await fixture("interrupted");
    try {
      const result = await f.gates.call({
        command: "run",
        task: "controlled",
        runtimeMode: "full-access",
        wait_seconds: 1,
      });
      assert.equal(result.ok, false);
      assert.equal(result.error, "run_external_unknown");
      assert.equal(existsSync(f.marker), false);
      assert.equal(gitRef(f.repo), f.base);
    } finally {
      await f.dispose();
    }
  });

  it("still refuses two distinct nonempty turns without stopping or mutating the attempt", async () => {
    const f = await fixture("running");
    try {
      const dispatched = await f.gates.call({
        command: "dispatch",
        task: "controlled",
        runtimeMode: "full-access",
      });
      assert.equal(dispatched.ok, true);
      f.sessions = [{ ...f.sessions[0]!, activeTurnId: "literal-turn-b" as never }];
      const before = (await f.gates.call({ command: "status", task: "controlled" })).task;
      const result = await f.gates.call({
        command: "reclaim",
        task: "controlled",
        attempt: dispatched.attempt!.attempt_id,
      });
      assert.equal(result.error, "identity_conflict");
      assert.deepEqual(
        (await f.gates.call({ command: "status", task: "controlled" })).task,
        before,
      );
      assert.deepEqual(f.effects, []);
      assert.equal(gitRef(f.repo), f.base);
    } finally {
      await f.dispose();
    }
  });

  it("keeps foreign identity, error, contradictory interruption and unknown running inputs refused", async () => {
    const f = await fixture("running");
    try {
      assert.equal(
        (
          await f.gates.call({
            command: "dispatch",
            task: "controlled",
            runtimeMode: "full-access",
          })
        ).ok,
        true,
      );
      let shell = structuredClone(f.shell);
      const active = structuredClone(f.sessions[0]!);
      for (const session of [
        { ...active, cwd: f.repo },
        { ...active, provider: "claude" },
      ]) {
        assert.throws(
          () => readManagedThread(shell, [session as ProviderSession]),
          (e: unknown) => e instanceof Refusal && e.code === "identity_conflict",
        );
      }
      assert.throws(
        () => readManagedThread(shell, [active, active]),
        (e: unknown) => e instanceof Refusal && e.code === "identity_conflict",
      );
      assert.throws(
        () => readManagedThread(shell, []),
        (e: unknown) => e instanceof Refusal && e.code === "run_external_unknown",
      );
      shell = { ...shell, session: { ...shell.session!, status: "error" } };
      assert.throws(
        () => readManagedThread(shell, [active]),
        (e: unknown) => e instanceof Refusal && e.code === "run_external_unknown",
      );
      shell = { ...shell, session: { ...shell.session!, status: "interrupted" } };
      assert.throws(
        () => readManagedThread(shell, [active]),
        (e: unknown) => e instanceof Refusal && e.code === "run_external_unknown",
      );
    } finally {
      await f.dispose();
    }
  });
});

function gitRef(repo: string) {
  return execFileSync("git", ["-C", repo, "rev-parse", "refs/a2a/integration"], {
    encoding: "utf8",
  }).trim();
}
