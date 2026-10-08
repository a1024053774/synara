import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnProcessSync } from "@synara/shared/processRuntime";
import { expect, test } from "vitest";
import { A2AGates, type GateRuntime } from "./core";

// Frozen supervised-run contract: historical cleanup must not select a new owner.
// Failure modes: reject the valid historical binding; change the current task;
// close a foreign/current thread; repeat a completed effect; close a working thread.
// This isolates ownership logic with real Git/SQLite and a thread boundary double.
// It provides no claim about a real provider, authentication, or native lifecycle.
test("reclaims only the specified historical attempt and preserves the replacement", async () => {
  const root = mkdtempSync(join(tmpdir(), "a2a-history-contract-"));
  console.log(JSON.stringify({ fixture_root: root }));
  const repo = join(root, "repo");
  mkdirSync(repo);
  const git = (...args: string[]) => {
    const result = spawnProcessSync("git", ["-C", repo, ...args], {
      encoding: "utf8",
      env: {
        ...process.env,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_TERMINAL_PROMPT: "0",
      },
    });
    expect(result.status, result.stderr).toBe(0);
    return result.stdout.trim();
  };
  git("init");
  git("config", "user.name", "Independent history fixture");
  git("config", "user.email", "fixture@example.invalid");
  git("config", "commit.gpgsign", "false");
  writeFileSync(join(repo, "input.txt"), "Sentinel input\n");
  git("add", "input.txt");
  git("commit", "-m", "Independent baseline");
  const base = git("rev-parse", "HEAD");
  const oracle = join(root, "oracle.py"),
    instructions = join(root, "instructions.txt");
  writeFileSync(oracle, "raise SystemExit(0)\n");
  writeFileSync(instructions, "Ownership fixture, no model invocation.\n");
  type Thread = {
    workspace: string;
    provider: string;
    turn: string | null;
    running: boolean;
    stopped: boolean;
    archived: boolean;
  };
  const threads = new Map<string, Thread>();
  const stopped: string[] = [],
    archived: string[] = [];
  const runtime: GateRuntime = {
    ensureProject: async () => {},
    createThread: async (_task, attempt) => {
      threads.set(attempt.thread_id, {
        workspace: attempt.workspace,
        provider: "codex",
        turn: null,
        running: false,
        stopped: false,
        archived: false,
      });
    },
    startThread: async () => {},
    readThread: async (thread) => {
      const value = threads.get(thread);
      if (!value) throw new Error("Unknown fixture thread");
      return { ...value };
    },
    stopThread: async (thread) => {
      stopped.push(thread);
      threads.get(thread)!.stopped = true;
    },
    archiveThread: async (thread) => {
      archived.push(thread);
      threads.get(thread)!.archived = true;
    },
  };
  const gates = new A2AGates(join(root, "state"), runtime);
  try {
    expect(
      (
        await gates.call({
          command: "create",
          task: "history",
          project: "project",
          repo,
          base,
          oracle,
          instructions,
        })
      ).ok,
    ).toBe(true);
    const first = await gates.call({
      command: "dispatch",
      task: "history",
      runtimeMode: "approval-required",
    });
    expect(first.ok).toBe(true);
    const old = first.task!.current_attempt!;
    expect(
      (
        await gates.call({
          command: "revoke",
          task: "history",
          reason: "Independent owner replacement",
        })
      ).ok,
    ).toBe(true);
    const second = await gates.call({
      command: "dispatch",
      task: "history",
      runtimeMode: "approval-required",
    });
    expect(second.ok).toBe(true);
    const replacement = second.task!.current_attempt!;
    const before = (await gates.call({ command: "status", task: "history" })).task;
    const cleanup = await gates.call({
      command: "reclaim",
      task: "history",
      attempt: old.attempt_id,
    });
    expect(cleanup.ok, JSON.stringify(cleanup)).toBe(true);
    expect(cleanup.task).toEqual(before);
    expect(stopped).toEqual([old.thread_id]);
    expect(archived).toEqual([old.thread_id]);
    expect(threads.get(replacement.thread_id)).toMatchObject({ stopped: false, archived: false });
    expect(
      (await gates.call({ command: "reclaim", task: "history", attempt: old.attempt_id })).ok,
    ).toBe(true);
    expect(stopped).toEqual([old.thread_id]);
    expect(archived).toEqual([old.thread_id]);
    expect(
      (
        await gates.call({
          command: "create",
          task: "foreign",
          project: "project",
          repo,
          base,
          oracle,
          instructions,
        })
      ).ok,
    ).toBe(true);
    expect(
      (await gates.call({ command: "reclaim", task: "foreign", attempt: old.attempt_id })).ok,
    ).toBe(false);
    expect(stopped).toEqual([old.thread_id]);
    expect(
      (await gates.call({ command: "revoke", task: "history", reason: "Second ownership probe" }))
        .ok,
    ).toBe(true);
    expect(
      (await gates.call({ command: "dispatch", task: "history", runtimeMode: "approval-required" }))
        .ok,
    ).toBe(true);
    const latest = (await gates.call({ command: "status", task: "history" })).task;
    threads.get(replacement.thread_id)!.running = true;
    const busy = await gates.call({
      command: "reclaim",
      task: "history",
      attempt: replacement.attempt_id,
    });
    expect(busy.error).toBe("worker_working");
    expect(stopped).toEqual([old.thread_id]);
    expect((await gates.call({ command: "status", task: "history" })).task).toEqual(latest);
  } finally {
    gates.close();
  }
}, 30_000);
