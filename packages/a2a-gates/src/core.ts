import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { A2AGateRequest, type A2AAttempt, type A2AGateResult, type A2ATask } from "@synara/contracts";
import { execProcessFile } from "@synara/shared/processRuntime";
import { Schema } from "effect";

const REF = "refs/a2a/integration";
class Refusal extends Error {
  constructor(readonly code: string, readonly details?: unknown) { super(code); }
}
function requireGate(value: unknown, code: string, details?: unknown): asserts value {
  if (!value) throw new Refusal(code, details);
}
function id(value: string | undefined): string {
  requireGate(value && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(value), "invalid_id");
  return value;
}
function sha(value: string | undefined): string {
  requireGate(value && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value), "invalid_commit");
  return value;
}
function inputPath(value: string | undefined, directory = false): string {
  requireGate(value && isAbsolute(value) && !/[\x00-\x1f]/.test(value), "invalid_path");
  const path = realpathSync(value);
  requireGate(directory ? statSync(path).isDirectory() : statSync(path).isFile(), "invalid_path");
  return path;
}

export interface GateRuntime {
  ensureProject(project: string, repo: string): Promise<void>;
  createThread(task: A2ATask, attempt: A2AAttempt): Promise<void>;
  startThread(task: A2ATask, attempt: A2AAttempt, prompt: string): Promise<void>;
  readThread(thread: string): Promise<{ workspace: string; provider: string; turn: string | null; running: boolean; stopped: boolean; archived: boolean }>;
  stopThread(thread: string): Promise<void>;
  archiveThread(thread: string): Promise<void>;
}
export interface SubmitCaller { thread: string; turn: string; assertActive(): Promise<void> }

/** The sole mutation owner. Thread lifecycle signals never invoke this core. */
export class A2AGates {
  private readonly db: DatabaseSync;
  constructor(readonly root: string, private readonly runtime: GateRuntime) {
    requireGate(isAbsolute(root), "invalid_path");
    mkdirSync(root, { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(join(root, "state.sqlite3"));
    this.db.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS events (seq INTEGER PRIMARY KEY AUTOINCREMENT, time TEXT NOT NULL, task TEXT NOT NULL, type TEXT NOT NULL, details TEXT NOT NULL);
      CREATE TRIGGER IF NOT EXISTS events_no_update BEFORE UPDATE ON events BEGIN SELECT RAISE(ABORT,'append only'); END;
      CREATE TRIGGER IF NOT EXISTS events_no_delete BEFORE DELETE ON events BEGIN SELECT RAISE(ABORT,'append only'); END;`);
    mkdirSync(join(root, "locks"), { recursive: true });
  }
  close() { this.db.close(); }
  taskForThread(thread: string): A2ATask | null {
    const rows = this.db.prepare("SELECT data FROM tasks").all();
    for (const row of rows) {
      const task = JSON.parse(String(row.data)) as A2ATask;
      if (task.current_attempt?.thread_id === thread) return task;
    }
    return null;
  }
  private event(task: string, type: string, details: unknown) {
    this.db.prepare("INSERT INTO events(time,task,type,details) VALUES (?,?,?,?)").run(new Date().toISOString(), task, type, JSON.stringify(details));
  }
  private load(task: string): A2ATask {
    const row = this.db.prepare("SELECT data FROM tasks WHERE id=?").get(task);
    requireGate(row, "unknown_task");
    return JSON.parse(String(row.data)) as A2ATask;
  }
  private save(task: A2ATask, type: string, details: unknown = task) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("INSERT INTO tasks(id,data) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data").run(task.task_id, JSON.stringify(task));
      this.event(task.task_id, type, details);
      this.db.exec("COMMIT");
    } finally { if (this.db.isTransaction) this.db.exec("ROLLBACK"); }
  }
  private async execute(task: string, argv: string[], cwd: string) {
    const command = argv[0]; requireGate(command, "invalid_command");
    this.event(task, "command_intent", { argv, cwd });
    const result = await new Promise<{ argv: string[]; cwd: string; stdout: string; stderr: string; exit: number | null }>((resolve, reject) => {
      execProcessFile(command, argv.slice(1), { cwd, encoding: "utf8", timeout: 60_000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
        if (error && typeof error.code !== "number") {
          this.event(task, "command_unknown", { argv, cwd, stdout, stderr, reason: error.message });
          reject(new Refusal("command_unknown", { argv, cwd, reason: error.message }));
        } else resolve({ argv, cwd, stdout, stderr, exit: error && typeof error.code === "number" ? error.code : 0 });
      });
    });
    this.event(task, "command_result", result); return result;
  }
  private async git(task: string, repo: string, args: string[], allowed = [0]) {
    const result = await this.execute(task, ["git", "-C", repo, ...args], repo);
    requireGate(result.exit !== null && allowed.includes(result.exit), "git_failed", result);
    return result.stdout.trim();
  }
  private async integration(task: A2ATask) {
    return this.git(task.task_id, task.repo, ["rev-parse", "--verify", "--quiet", REF], [0, 1]);
  }
  private current(task: A2ATask, expected?: string) {
    const attempt = task.current_attempt;
    requireGate(attempt && (!expected || attempt.attempt_id === expected), "stale_attempt");
    requireGate(attempt.task_id === task.task_id && attempt.fence === task.fence && attempt.spec_rev === task.spec_rev, "stale_attempt");
    return attempt;
  }

  async call(raw: unknown, caller?: SubmitCaller): Promise<A2AGateResult> {
    let taskId: string | undefined;
    let lock: DatabaseSync | undefined;
    try {
      const args = Schema.decodeUnknownSync(A2AGateRequest)(raw);
      taskId = id(args.task);
      if (args.command === "status") return { ok: true, task: this.load(taskId) };
      if (args.command === "events") {
        const rows = this.db.prepare("SELECT seq,time,type,details FROM events WHERE task=? ORDER BY seq").all(taskId);
        return { ok: true, events: rows.map(r => ({ seq: Number(r.seq), time: String(r.time), type: String(r.type), details: JSON.parse(String(r.details)) as unknown })) };
      }
      // A separate SQLite write transaction is the OS-released task operation lock.
      // Keep the inode, never unlink it. Main-state reads remain available during an oracle.
      lock = new DatabaseSync(join(this.root, "locks", `${taskId}.sqlite3`));
      lock.exec("PRAGMA busy_timeout=0");
      try { lock.exec("BEGIN IMMEDIATE"); }
      catch (error) {
        if ((error as { errcode?: number }).errcode === 5 || (error as Error).message.includes("database is locked")) throw new Refusal("operation_busy");
        throw error;
      }
      if (args.command === "create") {
        requireGate(!this.db.prepare("SELECT 1 FROM tasks WHERE id=?").get(taskId), "task_exists");
        const repo = inputPath(args.repo, true), oracle = inputPath(args.oracle), instructions = inputPath(args.instructions), base = sha(args.base);
        requireGate(await this.git(taskId, repo, ["rev-parse", "--show-toplevel"]) === repo, "invalid_repo");
        requireGate(await this.git(taskId, repo, ["cat-file", "-t", base]) === "commit", "invalid_commit");
        const snapshot = join(this.root, "tasks", `${taskId}-${randomUUID()}`);
        const task: A2ATask = { task_id: taskId, project_id: id(args.project), repo, oracle: join(snapshot, "oracle.py"), instructions: join(snapshot, "instructions.txt"), base_commit: base, state: "creating", spec_rev: 1, fence: 0, current_attempt: null, candidate_commit: null, verification: null, integration_intent: null };
        const actual = await this.integration(task); requireGate(!actual || actual === base, "integration_conflict");
        const instructionBytes = readFileSync(instructions); new TextDecoder("utf-8", { fatal: true }).decode(instructionBytes);
        const oracleBytes = readFileSync(oracle);
        this.save(task, "create_intent", { task, oracle_source: oracle, instructions_source: instructions });
        mkdirSync(snapshot, { recursive: true });
        writeFileSync(task.oracle, oracleBytes, { flag: "wx", mode: 0o400 });
        writeFileSync(task.instructions, instructionBytes, { flag: "wx", mode: 0o400 });
        if (!actual) await this.git(taskId, repo, ["update-ref", REF, base, "0".repeat(base.length)]);
        requireGate(await this.integration(task) === base, "integration_conflict");
        await this.runtime.ensureProject(task.project_id, repo);
        task.state = "ready"; this.save(task, "created"); return { ok: true, task };
      }
      const task = this.load(taskId);
      if (args.command === "dispatch") {
        requireGate(task.state === "ready" && !task.current_attempt, "already_claimed");
        const base = sha(await this.integration(task));
        const attempt: A2AAttempt = { task_id: taskId, attempt_id: randomUUID(), session_id: randomUUID(), fence: task.fence + 1, spec_rev: task.spec_rev, thread_id: randomUUID(), turn_id: null, workspace: "", base_commit: base, reclaimed: false };
        attempt.workspace = join(this.root, "worktrees", attempt.attempt_id);
        task.current_attempt = attempt; task.fence = attempt.fence; task.state = "preparing";
        this.save(task, "dispatch_intent", { attempt, model: "gpt-6.1-sol", reasoning_effort: "xhigh", requested_service_tier: "fast" });
        mkdirSync(join(this.root, "worktrees"), { recursive: true });
        await this.git(taskId, task.repo, ["worktree", "add", "--detach", attempt.workspace, base]);
        await this.runtime.createThread(task, attempt);
        task.state = "claimed"; this.save(task, "claimed");
        const submit = { command: "submit", task: taskId, attempt: attempt.attempt_id, session: attempt.session_id, fence: attempt.fence, spec_rev: attempt.spec_rev, commit: "<FULL_COMMIT_SHA>" };
        const prompt = `${readFileSync(task.instructions, "utf8")}\n\nManaged attempt identity: ${JSON.stringify(submit)}\nAfter implementing and committing, explicitly call the a2a_submit MCP tool with this identity and your full commit SHA. Never submit passed=true. Only this tool delivers your work; turn completion does not. Do not modify the contract or any acceptance tool. If any unexpected approval is requested, stop and report it.`;
        this.event(taskId, "prompt_intent", { thread: attempt.thread_id, prompt });
        await this.runtime.startThread(task, attempt, prompt);
        this.event(taskId, "dispatched", { attempt }); return { ok: true, task };
      }
      const attempt = this.current(task, args.attempt);
      if (args.command === "submit") {
        requireGate(args.attempt === attempt.attempt_id, "stale_attempt");
        requireGate(args.session === attempt.session_id, "stale_session");
        requireGate(args.fence === attempt.fence, "stale_fence");
        requireGate(args.spec_rev === task.spec_rev, "stale_spec");
        requireGate(caller && caller.thread === attempt.thread_id, "stale_thread");
        await caller.assertActive();
        const live = await this.runtime.readThread(attempt.thread_id);
        requireGate(live.workspace === attempt.workspace && live.provider === "codex" && live.running && live.turn === caller.turn, "identity_conflict");
        requireGate(!attempt.turn_id || attempt.turn_id === caller.turn, "stale_turn");
        requireGate(["claimed", "submitted"].includes(task.state), "invalid_state");
        const commit = sha(args.commit);
        requireGate(!task.candidate_commit || task.candidate_commit === commit, "candidate_conflict");
        requireGate(await this.git(taskId, task.repo, ["cat-file", "-t", commit]) === "commit", "invalid_commit");
        const ancestor = await this.execute(taskId, ["git", "-C", task.repo, "merge-base", "--is-ancestor", attempt.base_commit, commit], task.repo);
        requireGate(ancestor.exit === 0, "not_descendant");
        requireGate(await this.git(taskId, attempt.workspace, ["rev-parse", "HEAD"]) === commit, "workspace_head_mismatch");
        requireGate(!await this.git(taskId, attempt.workspace, ["status", "--porcelain=v1", "--untracked-files=all"]), "dirty_worktree");
        await caller.assertActive();
        attempt.turn_id = caller.turn; task.candidate_commit = commit; task.state = "submitted";
        this.save(task, "submitted", { attempt, commit }); return { ok: true, task };
      }
      if (args.command === "verify") {
        requireGate(task.state === "submitted" && task.candidate_commit, task.state === "verifying" ? "needs_reconciliation" : "not_submitted");
        requireGate(!task.integration_intent, "needs_reconciliation");
        const G = sha(await this.integration(task)), C = task.candidate_commit;
        // This slice supports only a descendant of the live integration head.
        // Divergence requires the later merge/recovery ticket, never stale acceptance.
        const ancestor = await this.execute(taskId, ["git", "-C", task.repo, "merge-base", "--is-ancestor", G, C], task.repo);
        requireGate(ancestor.exit === 0, "integration_conflict");
        const verification_id = randomUUID(), workspace = join(this.root, "verification", verification_id);
        task.verification = { verification_id, attempt: { ...attempt }, spec_rev: task.spec_rev, G, C, M: C, oracle: task.oracle, workspace, state: "running" };
        task.state = "verifying"; this.save(task, "verification_intent", task.verification);
        mkdirSync(join(this.root, "verification"), { recursive: true });
        await this.git(taskId, task.repo, ["worktree", "add", "--detach", workspace, C]);
        const result = await this.execute(taskId, ["python3", "-I", "-B", task.oracle, workspace], workspace);
        task.verification.result = result; task.verification.state = result.exit === 0 ? "passed" : "failed";
        task.state = result.exit === 0 ? "verified" : "submitted"; this.save(task, "verification_result", task.verification);
        requireGate(result.exit === 0, "oracle_failed", task.verification); return { ok: true, task };
      }
      if (args.command === "integrate") {
        if (task.state === "accepted") return { ok: true, task };
        requireGate(!task.integration_intent, "needs_reconciliation");
        const v = task.verification;
        requireGate(task.state === "verified" && v?.state === "passed", "not_verified");
        requireGate(JSON.stringify(v.attempt) === JSON.stringify(attempt) && v.spec_rev === task.spec_rev && v.C === task.candidate_commit && v.oracle === task.oracle, "stale_verification");
        if (await this.integration(task) !== v.G) {
          task.state = "submitted"; task.verification = null; this.save(task, "integration_conflict");
          throw new Refusal("integration_conflict");
        }
        task.integration_intent = { G: v.G, M: v.M, verification_id: v.verification_id, attempt: { ...attempt }, state: "pending" };
        task.state = "integrating"; this.save(task, "integration_intent", task.integration_intent);
        await this.git(taskId, task.repo, ["update-ref", REF, v.M, v.G]);
        requireGate(await this.integration(task) === v.M, "needs_reconciliation");
        task.integration_intent.state = "completed"; task.state = "accepted"; this.save(task, "integrated"); return { ok: true, task };
      }
      requireGate(args.command === "reclaim", "invalid_command");
      if (attempt.reclaimed) return { ok: true, task };
      requireGate(["accepted", "claimed", "submitted"].includes(task.state) && !task.integration_intent?.state.includes("pending"), "needs_reconciliation");
      const live = await this.runtime.readThread(attempt.thread_id);
      requireGate(live.workspace === attempt.workspace && live.provider === "codex", "identity_conflict");
      requireGate(!live.running, "worker_working");
      this.event(taskId, "reclaim_intent", { attempt, live });
      if (task.state !== "accepted") { task.state = "revoked"; this.save(task, "revoked"); }
      await this.runtime.stopThread(attempt.thread_id);
      const stopped = await this.runtime.readThread(attempt.thread_id); requireGate(stopped.stopped, "stop_unconfirmed");
      await this.runtime.archiveThread(attempt.thread_id);
      const archived = await this.runtime.readThread(attempt.thread_id); requireGate(archived.archived && archived.stopped, "reclaim_unconfirmed");
      attempt.reclaimed = true; this.save(task, "reclaimed", { attempt, archived }); return { ok: true, task };
    } catch (error) {
      const code = error instanceof Refusal ? error.code : "gate_failure";
      const details = error instanceof Refusal ? error.details : String(error);
      if (taskId) this.event(taskId, "rejected", { error: code, details });
      return { ok: false, error: code, details };
    } finally { lock?.close(); }
  }
}
