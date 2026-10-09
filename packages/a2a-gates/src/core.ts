import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  A2AGateRequest,
  A2AInboxRequest,
  A2AStopRequest,
  type A2AInboxEntry,
  type A2AInboxDelivery,
  type A2AAttempt,
  type A2ARun,
  type A2AUserInputObserver,
  type A2AGateResult,
  type A2AVerification,
  type A2ACommandResult,
  type A2ATask,
  type A2AAttachment,
  type A2ATaskMembership,
  type A2AIssueRecord,
  type A2AIssueView,
  type A2AUserInput,
  ProjectId,
  ThreadId,
} from "@synara/contracts";
import { execProcessFile } from "@synara/shared/processRuntime";
import { Schema } from "effect";
import { A2AMembership } from "./membership";

const REF = "refs/a2a/integration";
export class Refusal extends Error {
  constructor(
    readonly code: string,
    readonly details?: unknown,
  ) {
    super(code);
  }
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
function text(value: string | undefined): string {
  requireGate(value && value.trim() && !/[\x00-\x1f]/.test(value), "invalid_text");
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
  readThread(thread: string): Promise<{
    workspace: string;
    provider: string;
    turn: string | null;
    running: boolean;
    stopped: boolean;
    archived: boolean;
    blocked?: boolean;
    error?: { providerPresent: boolean; activeTurn: string | null };
  }>;
  stopThread(thread: string): Promise<void>;
  archiveThread(thread: string): Promise<void>;
  createAttachedThread?(task: A2ATask, attachment: A2AAttachment, prompt: string): Promise<void>;
  sendUserAnswer?(thread: string, messageId: string, message: string): Promise<void>;
  wakeThread?(thread: string, entry: A2AInboxEntry): Promise<{ message: string }>;
  interruptThread?(thread: string): Promise<void>;
}
export interface SubmitCaller {
  thread: string;
  turn: string;
  assertActive(): Promise<void>;
  address?: string;
}

/** The sole mutation owner. Thread lifecycle signals never invoke this core. */
export class A2AGates {
  private readonly db: DatabaseSync;
  private readonly membership: A2AMembership;
  private userInputObserver?: A2AUserInputObserver;
  private readonly deferredUserInputs = new Map<string, A2AUserInput>();
  constructor(
    readonly root: string,
    private readonly runtime?: GateRuntime,
    private readonly now: () => number = Date.now,
  ) {
    requireGate(isAbsolute(root), "invalid_path");
    mkdirSync(root, { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(join(root, "state.sqlite3"));
    this.membership = new A2AMembership(root);
    this.db.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS attempts (id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS verifications (id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, task TEXT NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS attachments (id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS user_input_events (event_id TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS user_input_checkpoint (id INTEGER PRIMARY KEY CHECK(id=1), sequence INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS user_input_ingress (command_id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TRIGGER IF NOT EXISTS user_input_ingress_no_update BEFORE UPDATE ON user_input_ingress BEGIN SELECT RAISE(ABORT,'append only'); END;
      CREATE TRIGGER IF NOT EXISTS user_input_ingress_no_delete BEFORE DELETE ON user_input_ingress BEGIN SELECT RAISE(ABORT,'append only'); END;
      CREATE TABLE IF NOT EXISTS issue_records (id TEXT PRIMARY KEY, task TEXT NOT NULL, thread TEXT NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS inbox_records (id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TRIGGER IF NOT EXISTS inbox_records_no_update BEFORE UPDATE ON inbox_records BEGIN SELECT RAISE(ABORT,'append only'); END;
      CREATE TRIGGER IF NOT EXISTS inbox_records_no_delete BEFORE DELETE ON inbox_records BEGIN SELECT RAISE(ABORT,'append only'); END;
      CREATE TABLE IF NOT EXISTS inbox_deliveries (seq INTEGER PRIMARY KEY AUTOINCREMENT, entry TEXT NOT NULL, data TEXT NOT NULL);
      CREATE TRIGGER IF NOT EXISTS inbox_deliveries_no_update BEFORE UPDATE ON inbox_deliveries BEGIN SELECT RAISE(ABORT,'append only'); END;
      CREATE TRIGGER IF NOT EXISTS inbox_deliveries_no_delete BEFORE DELETE ON inbox_deliveries BEGIN SELECT RAISE(ABORT,'append only'); END;
      CREATE TABLE IF NOT EXISTS user_inputs (id TEXT PRIMARY KEY, task TEXT, message TEXT, data TEXT NOT NULL);
      CREATE TRIGGER IF NOT EXISTS issue_records_no_update BEFORE UPDATE ON issue_records BEGIN SELECT RAISE(ABORT,'append only'); END;
      CREATE TRIGGER IF NOT EXISTS issue_records_no_delete BEFORE DELETE ON issue_records BEGIN SELECT RAISE(ABORT,'append only'); END;
      CREATE TRIGGER IF NOT EXISTS user_inputs_no_update BEFORE UPDATE ON user_inputs BEGIN SELECT RAISE(ABORT,'append only'); END;
      CREATE TRIGGER IF NOT EXISTS user_inputs_no_delete BEFORE DELETE ON user_inputs BEGIN SELECT RAISE(ABORT,'append only'); END;
      CREATE TABLE IF NOT EXISTS events (seq INTEGER PRIMARY KEY AUTOINCREMENT, time TEXT NOT NULL, task TEXT NOT NULL, attempt TEXT, type TEXT NOT NULL, details TEXT NOT NULL);
      CREATE TRIGGER IF NOT EXISTS events_no_update BEFORE UPDATE ON events BEGIN SELECT RAISE(ABORT,'append only'); END;
      CREATE TRIGGER IF NOT EXISTS events_no_delete BEFORE DELETE ON events BEGIN SELECT RAISE(ABORT,'append only'); END;`);
    // T-055 registered one input per message. A reply bundle has one message
    // and several immutable inputs. Preserve every legacy row byte-for-byte
    // while removing only the obsolete message uniqueness constraint.
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const messageUnique = this.db
        .prepare("PRAGMA index_list(user_inputs)")
        .all()
        .some((index) => {
          const columns = this.db
            .prepare(`PRAGMA index_info('${String(index.name).replaceAll("'", "''")}')`)
            .all();
          return index.unique === 1 && columns.length === 1 && columns[0]!.name === "message";
        });
      const legacyColumns = this.db.prepare("PRAGMA table_info(user_inputs)").all();
      if (
        messageUnique ||
        legacyColumns.some(
          (column) => (column.name === "task" || column.name === "message") && column.notnull === 1,
        )
      )
        this.db.exec(`
        CREATE TABLE user_inputs_bundle (id TEXT PRIMARY KEY, task TEXT, message TEXT, data TEXT NOT NULL);
        INSERT INTO user_inputs_bundle SELECT id,task,message,data FROM user_inputs ORDER BY rowid;
        DROP TABLE user_inputs;
        ALTER TABLE user_inputs_bundle RENAME TO user_inputs;
        CREATE TRIGGER user_inputs_no_update BEFORE UPDATE ON user_inputs BEGIN SELECT RAISE(ABORT,'append only'); END;
        CREATE TRIGGER user_inputs_no_delete BEFORE DELETE ON user_inputs BEGIN SELECT RAISE(ABORT,'append only'); END;`);
      this.db.exec("CREATE INDEX IF NOT EXISTS user_inputs_message ON user_inputs(message)");
      // Copy the old dedup ledger atomically. Historical immutable events remain unchanged.
      if (
        this.db
          .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='human_inputs'")
          .get()
      ) {
        this.db.exec(
          "INSERT OR IGNORE INTO user_input_events SELECT event_id FROM human_inputs; DROP TABLE human_inputs",
        );
      }
      this.db.exec("COMMIT");
    } finally {
      if (this.db.isTransaction) this.db.exec("ROLLBACK");
    }
    if (
      !this.db
        .prepare("PRAGMA table_info(events)")
        .all()
        .some((column) => column.name === "attempt")
    )
      this.db.exec("ALTER TABLE events ADD COLUMN attempt TEXT");
    mkdirSync(join(root, "locks"), { recursive: true });
  }
  close() {
    this.membership.close();
    this.db.close();
  }
  private operationLock(task: string): DatabaseSync {
    const lock = new DatabaseSync(join(this.root, "locks", `${task}.sqlite3`));
    lock.exec("PRAGMA busy_timeout=0");
    try {
      lock.exec("BEGIN IMMEDIATE");
      return lock;
    } catch (error) {
      lock.close();
      if (
        (error as { errcode?: number }).errcode === 5 ||
        (error as Error).message.includes("database is locked")
      )
        throw new Refusal("operation_busy");
      throw error;
    }
  }
  /** The manual correction route shares the gate operation lock and revision CAS. */
  saveMembership(input: A2ATaskMembership): A2ATaskMembership {
    const lock = this.operationLock(id(input.taskId));
    try {
      this.checkUserInputObserver();
      const row = this.db.prepare("SELECT data FROM tasks WHERE id=?").get(input.taskId);
      if (row)
        requireGate(
          (JSON.parse(String(row.data)) as A2ATask).project_id === input.projectId,
          "gate_project_mismatch",
        );
      // Lifecycle comes from durable gate bindings, never from a manual editor.
      const current = this.membership.list().find((task) => task.taskId === input.taskId);
      return this.membership.save({
        ...input,
        members: input.members.map(({ threadId, role }) => {
          const attached = this.db.prepare("SELECT data FROM attachments WHERE id=?").get(threadId);
          const attachment = attached
            ? (JSON.parse(String(attached.data)) as A2AAttachment)
            : undefined;
          const worker = this.db
            .prepare("SELECT data FROM attempts WHERE json_extract(data,'$.thread_id')=?")
            .get(threadId);
          const attempt = worker ? (JSON.parse(String(worker.data)) as A2AAttempt) : undefined;
          let endedAt =
            attachment?.state === "ended"
              ? attachment.ended_at
              : attempt?.reclaimed
                ? attempt.reclaimed_at
                : current?.members.find((member) => member.threadId === threadId)?.endedAt;
          if (attempt?.reclaimed && !endedAt) {
            // Published attempt records before reclaimed_at retain their
            // completion time in the append-only event journal.
            const completed = this.db
              .prepare(
                "SELECT time FROM events WHERE task=? AND attempt=? AND type='reclaimed' ORDER BY seq DESC LIMIT 1",
              )
              .get(attempt.task_id, attempt.attempt_id);
            requireGate(completed, "reclaim_unconfirmed");
            endedAt = String(completed.time);
          }
          return { threadId, role, ...(endedAt ? { endedAt } : {}) };
        }),
      });
    } finally {
      lock.close();
    }
  }
  private taskMembership(task: A2ATask): A2ATaskMembership {
    const current = this.membership.list().find((item) => item.taskId === task.task_id);
    if (current) {
      requireGate(current.projectId === task.project_id, "gate_project_mismatch");
      return current;
    }
    return this.membership.save({
      taskId: task.task_id,
      projectId: ProjectId.makeUnsafe(task.project_id),
      title: task.title ?? task.task_id,
      revision: 0,
      members: [],
    });
  }
  private member(task: A2ATask, thread: string, role: A2AAttachment["role"], endedAt?: string) {
    const membership = this.taskMembership(task);
    const previous = membership.members.find((member) => member.threadId === thread);
    const member = {
      threadId: ThreadId.makeUnsafe(thread),
      role: previous?.role ?? role,
      ...(endedAt ? { endedAt } : previous?.endedAt ? { endedAt: previous.endedAt } : {}),
    };
    if (previous && previous.endedAt === member.endedAt) return;
    this.membership.save({
      ...membership,
      members: previous
        ? membership.members.map((value) => (value.threadId === thread ? member : value))
        : [...membership.members, member],
    });
  }
  private saveAttachment(attachment: A2AAttachment) {
    this.db
      .prepare(
        "INSERT INTO attachments(id,data) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data",
      )
      .run(attachment.thread_id, JSON.stringify(attachment));
  }
  userInputObserverStatus(): A2AUserInputObserver | undefined {
    const status = this.userInputObserver;
    return status
      ? { ...status, ...(status.failure ? { failure: { ...status.failure } } : {}) }
      : undefined;
  }
  setUserInputObserverStatus(
    state: A2AUserInputObserver["state"],
    failure?: A2AUserInputObserver["failure"],
  ) {
    // A failed recorder cannot reset itself. A new service instance must replay
    // the durable Synara journal before reporting healthy again.
    if (this.userInputObserver?.state === "failed") return;
    this.userInputObserver = {
      state,
      updated_at: new Date().toISOString(),
      ...(failure ? { failure } : {}),
    };
  }
  private checkUserInputObserver() {
    requireGate(
      this.userInputObserver?.state !== "failed",
      "user_input_observer_failed",
      this.userInputObserverStatus(),
    );
  }
  taskForThread(thread: string): A2ATask | null {
    if (!thread) return null;
    const rows = this.db.prepare("SELECT data FROM tasks").all();
    for (const row of rows) {
      const task = JSON.parse(String(row.data)) as A2ATask;
      if (task.current_attempt?.thread_id === thread) return task;
    }
    return null;
  }
  userInputTarget(thread: string, project?: string | null): A2AUserInput["target"] {
    const row = this.db
      .prepare("SELECT data FROM attempts WHERE json_extract(data,'$.thread_id')=?")
      .get(thread);
    const attempt = row ? (JSON.parse(String(row.data)) as A2AAttempt) : undefined;
    const member = this.membership
      .list()
      .find((task) => task.members.some((m) => m.threadId === thread));
    const taskId = attempt?.task_id ?? member?.taskId ?? null;
    const taskRow = taskId
      ? this.db.prepare("SELECT data FROM tasks WHERE id=?").get(taskId)
      : undefined;
    const task = taskRow ? (JSON.parse(String(taskRow.data)) as A2ATask) : undefined;
    return {
      project: task?.project_id ?? member?.projectId ?? project ?? null,
      task: taskId,
      attempt: attempt?.attempt_id ?? null,
      thread,
      turn: null,
      message: null,
      request: null,
    };
  }
  /** Only the WS entry registers these receipts; domain replay never guesses command provenance. */
  registerUserInputCommand(commandId: string, input: A2AUserInput): void {
    this.db
      .prepare("INSERT OR IGNORE INTO user_input_ingress(command_id,data) VALUES (?,?)")
      .run(commandId, JSON.stringify(input));
  }
  userInputCommand(commandId: string): A2AUserInput | undefined {
    const row = this.db
      .prepare("SELECT data FROM user_input_ingress WHERE command_id=?")
      .get(commandId);
    return row ? (JSON.parse(String(row.data)) as A2AUserInput) : undefined;
  }
  userInputCheckpoint(): number | undefined {
    const row = this.db.prepare("SELECT sequence FROM user_input_checkpoint WHERE id=1").get();
    return row ? Number(row.sequence) : undefined;
  }
  advanceUserInputCheckpoint(sequence: number): void {
    this.db
      .prepare(
        "INSERT INTO user_input_checkpoint(id,sequence) VALUES (1,?) ON CONFLICT(id) DO UPDATE SET sequence=max(sequence,excluded.sequence)",
      )
      .run(sequence);
  }
  userInputCommands(): ReadonlyArray<{ commandId: string; input: A2AUserInput }> {
    return this.db
      .prepare("SELECT command_id,data FROM user_input_ingress ORDER BY rowid")
      .all()
      .map((row) => ({
        commandId: String(row.command_id),
        input: JSON.parse(String(row.data)) as A2AUserInput,
      }));
  }
  deferUserInput(commandId: string, input: A2AUserInput): void {
    // The RPC observation is still authoritative while this process retains it.
    this.deferredUserInputs.set(commandId, input);
  }
  flushDeferredUserInputs(): void {
    for (const [commandId, input] of this.deferredUserInputs) {
      this.registerUserInputCommand(commandId, input);
      this.appendUserInput(input, `rpc:${commandId}`);
      this.deferredUserInputs.delete(commandId);
    }
  }
  recordUserInput(input: {
    thread_id: string;
    message_id: string;
    event_id: string;
    source_sequence: number;
    turn_id: string | null;
    created_at: string;
    text: string;
    dispatch_origin: "user";
    project_id?: string | null;
    answer?: { request: string; content: unknown };
    attachments?: unknown;
  }): boolean {
    requireGate(
      input.event_id && input.message_id && input.dispatch_origin === "user",
      "invalid_user_input",
    );
    // Answer registration suppresses its dispatched message, including replay overlap.
    if (this.db.prepare("SELECT 1 FROM user_inputs WHERE message=?").get(input.message_id))
      return false;
    const target = this.userInputTarget(input.thread_id, input.project_id);
    return this.appendUserInput(
      {
        id: randomUUID(),
        schema: 1,
        form: input.answer ? "answer" : "message",
        text: input.text,
        target: {
          ...target,
          turn: input.turn_id,
          message: input.message_id,
          request: input.answer?.request ?? null,
        },
        channel: "thread-message",
        reply_to: input.answer?.request ?? null,
        source_ref: {
          message_id: input.message_id,
          event_id: input.event_id,
          source_sequence: input.source_sequence,
        },
        certainty: "observed",
        created_at: input.created_at,
        ...(input.answer
          ? { content: input.answer.content }
          : input.attachments
            ? { content: { attachments: input.attachments } }
            : {}),
      },
      input.event_id,
    );
  }
  appendUserInput(input: A2AUserInput, source: string): boolean {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const inserted = this.db
        .prepare("INSERT OR IGNORE INTO user_input_events(event_id) VALUES (?)")
        .run(source);
      if (!inserted.changes) return false;
      this.saveUserInput(input);
      if (
        input.target.attempt &&
        input.target.task &&
        input.channel !== "ui-derived" &&
        input.form !== "gap"
      ) {
        const row = this.db
          .prepare("SELECT data FROM attempts WHERE id=?")
          .get(input.target.attempt)!;
        const attempt = JSON.parse(String(row.data)) as A2AAttempt;
        this.event(
          input.target.task,
          "human_intervention",
          {
            input_id: input.id,
            task_id: input.target.task,
            attempt_id: input.target.attempt,
            thread_id: input.target.thread,
            turn_id: input.target.turn,
            message_id: input.target.message,
            request_id: input.target.request ?? null,
            channel: input.channel,
            form: input.form,
            event_id: input.source_ref.event_id ?? input.source_ref.command_id,
            source_sequence: input.source_ref.source_sequence,
            session_id: attempt.session_id,
            fence: attempt.fence,
            spec_rev: attempt.spec_rev,
            dispatch_origin: "user",
            text: input.text,
          },
          input.target.attempt,
        );
      }
      this.db.exec("COMMIT");
      return true;
    } finally {
      if (this.db.isTransaction) this.db.exec("ROLLBACK");
    }
  }
  private saveUserInput(input: A2AUserInput) {
    this.db.prepare("INSERT INTO user_inputs(id,task,message,data) VALUES (?,?,?,?)").run(
      input.id,
      input.target.task,
      input.target.message,
      JSON.stringify({
        ...input,
        target: { ...this.userInputTarget(input.target.thread), ...input.target },
      }),
    );
  }
  private appendIssue(record: A2AIssueRecord) {
    const ownsTransaction = !this.db.isTransaction;
    if (ownsTransaction) this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db
        .prepare("INSERT INTO issue_records(id,task,thread,data) VALUES (?,?,?,?)")
        .run(record.id, record.task_id, record.thread_id, JSON.stringify(record));
      const sequence = this.event(
        record.task_id,
        `issue_${record.kind === "disposition" ? record.action : record.kind}`,
        record,
        record.attempt_id,
      );
      if (ownsTransaction) this.db.exec("COMMIT");
      return sequence;
    } finally {
      if (ownsTransaction && this.db.isTransaction) this.db.exec("ROLLBACK");
    }
  }
  private readIssues(task: string, thread?: string) {
    const records = this.db
      .prepare("SELECT data FROM issue_records WHERE task=? ORDER BY rowid")
      .all(task)
      .map((row) => JSON.parse(String(row.data)) as A2AIssueRecord)
      .filter((record) => thread === undefined || record.thread_id === thread);
    const issues: A2AIssueView[] = records
      .filter((record) => record.kind === "issue")
      .map((issue) => {
        const chain = records.filter((record) => record.issue_id === issue.id);
        const requested = chain.findLastIndex(
          (record) => record.action === "reopen" || record.action === "needs-user",
        );
        const answer = chain.slice(requested + 1).findLast((record) => record.kind === "answer");
        const disposition = chain.findLast((record) => record.kind === "disposition");
        const last = chain.at(-1)!;
        const elapsed = Math.max(0, this.now() - Date.parse(last.created_at));
        const state: A2AIssueView["state"] =
          last.kind === "answer"
            ? "已答复"
            : last.action === "delivered"
              ? "已送达"
              : last.action === "close" || last.action === "dismiss"
                ? "已关闭"
                : last.action === "forward"
                  ? elapsed < 900_000
                    ? "已转交"
                    : "等你决定"
                  : last.action === "snooze"
                    ? elapsed < 3_600_000
                      ? "稍后"
                      : "等你决定"
                    : last.kind === "disposition" || issue.blocking || elapsed >= 900_000
                      ? "等你决定"
                      : "待判断";
        return {
          issue,
          state,
          ...(answer ? { answer } : {}),
          ...(disposition ? { disposition } : {}),
        };
      });
    const user_inputs = this.db
      .prepare("SELECT data FROM user_inputs WHERE task=? ORDER BY rowid")
      .all(task)
      .map((row) => JSON.parse(String(row.data)) as A2AUserInput)
      .filter((input) => thread === undefined || input.target.thread === thread);
    return { records, issues, user_inputs };
  }
  /** MCP credentials own identity; arguments cannot select another thread. */
  async raiseIssue(
    input: { title: string; body: string; blocking: boolean; refs: ReadonlyArray<string> },
    caller: SubmitCaller,
  ) {
    const binding = this.ownedThread(caller.thread);
    requireGate(
      binding && ["worker", "reviewer", "monitor"].includes(binding.role),
      "stale_thread",
    );
    const task = binding.task;
    const lock = this.operationLock(task.task_id);
    try {
      this.checkUserInputObserver();
      const current = this.load(task.task_id);
      const attempt = binding.attempt;
      if (attempt)
        requireGate(current.current_attempt?.attempt_id === attempt.attempt_id, "stale_thread");
      requireGate(input.title.trim().length > 0, "invalid_title");
      await caller.assertActive();
      requireGate(this.runtime, "native_runtime_required");
      const live = await this.runtime.readThread(caller.thread);
      requireGate(
        !live.error &&
          live.workspace === (attempt?.workspace ?? task.repo) &&
          live.provider === (binding.attachment?.modelSelection.provider ?? "codex") &&
          !live.archived &&
          live.running &&
          !live.blocked &&
          live.turn === caller.turn,
        "identity_conflict",
      );
      await caller.assertActive();
      const issueId = randomUUID();
      const number =
        Number(
          this.db
            .prepare(
              "SELECT count(*) AS count FROM issue_records WHERE thread=? AND json_extract(data,'$.kind')='issue'",
            )
            .get(caller.thread)!.count,
        ) + 1;
      const issue: A2AIssueRecord = {
        id: issueId,
        schema: 1,
        kind: "issue",
        from: `${binding.role}:${caller.thread}`,
        to: "triage",
        reply_to: null,
        refs: [
          `task:${task.task_id}`,
          ...(attempt ? [`attempt:${attempt.attempt_id}`] : []),
          `thread:${caller.thread}`,
          `turn:${caller.turn}`,
          ...input.refs,
        ],
        created_at: new Date(this.now()).toISOString(),
        body: input.body,
        task_id: task.task_id,
        attempt_id: attempt?.attempt_id ?? null,
        thread_id: caller.thread,
        turn_id: caller.turn,
        number,
        title: input.title,
        blocking: input.blocking,
        issue_id: issueId,
      };
      this.db.exec("BEGIN IMMEDIATE");
      try {
        this.appendIssue(issue);
        this.db.exec("COMMIT");
      } finally {
        if (this.db.isTransaction) this.db.exec("ROLLBACK");
      }
      return { ok: true, id: issueId, number };
    } finally {
      lock.close();
    }
  }
  private async disposeIssue(
    args: A2AGateRequest,
    caller?: SubmitCaller,
    actor = caller ? (caller.address ?? `controller:${caller.thread}`) : "user",
  ): Promise<A2AGateResult> {
    const view = this.readIssues(args.task).issues.find((entry) => entry.issue.id === args.issue);
    requireGate(view, "unknown_issue");
    requireGate(args.action, "invalid_action");
    if (args.action === "dismiss" || args.action === "snooze" || args.action === "reopen")
      requireGate(actor === "user", "user_required");
    if (args.action === "close") {
      requireGate(!view.issue.blocking || actor === "user", "blocking_requires_user");
      requireGate(args.reason?.trim() && args.basis?.trim(), "close_requires_reason_basis");
    }
    if (args.action === "delivered")
      requireGate(
        view.answer?.input_id &&
          view.answer.message_id &&
          view.answer.bundle_id &&
          this.readIssues(args.task).records.some(
            (record) =>
              record.issue_id === view.issue.id &&
              record.action === "delivered" &&
              record.message_id === view.answer!.message_id,
          ),
        "delivery_unconfirmed",
      );
    const record: A2AIssueRecord = {
      ...view.issue,
      id: randomUUID(),
      kind: "disposition",
      action: args.action,
      from: actor,
      to:
        args.action === "forward"
          ? "ideation"
          : args.action === "needs-user" || args.action === "reopen"
            ? "user"
            : "triage",
      reply_to: view.issue.id,
      body: args.body ?? args.reason ?? (args.action === "dismiss" ? "用户选择不处理" : ""),
      ...(args.reason !== undefined || args.action === "dismiss"
        ? { reason: args.reason ?? "用户选择不处理" }
        : {}),
      ...(args.basis !== undefined || args.action === "dismiss"
        ? { basis: args.basis ?? "用户直接选择不处理" }
        : {}),
      ...(args.action === "delivered"
        ? {
            input_id: view.answer!.input_id!,
            message_id: view.answer!.message_id!,
            bundle_id: view.answer!.bundle_id!,
          }
        : {}),
      created_at: new Date(this.now()).toISOString(),
      refs: [
        ...view.issue.refs,
        `issue:${view.issue.id}`,
        ...(caller ? [`actor-thread:${caller.thread}`] : []),
      ],
    };
    this.appendIssue(record);
    const delivery =
      record.to === "ideation" || record.to === "executor"
        ? await this.deliverInbox(record)
        : undefined;
    return {
      ok: true,
      ...this.readIssues(args.task),
      entry: record,
      ...(delivery ? { delivery } : {}),
    };
  }
  private async answerIssues(args: A2AGateRequest): Promise<A2AGateResult> {
    const replies =
      args.command === "answer_issue" ? [{ issue: args.issue, answer: args.answer }] : args.answers;
    requireGate(
      replies?.length && new Set(replies.map((reply) => reply.issue)).size === replies.length,
      "invalid_answers",
    );
    const { issues } = this.readIssues(args.task);
    const rows = replies.map((reply) => {
      const view = issues.find((view) => view.issue.id === reply.issue);
      requireGate(view, "unknown_issue");
      requireGate(view.state !== "已关闭", "issue_closed");
      requireGate(!view.answer, "issue_answered");
      requireGate(
        typeof reply.answer === "string" && reply.answer.trim().length > 0,
        "invalid_answer",
      );
      return { issue: view.issue, answer: reply.answer.trimEnd() };
    });
    requireGate(this.runtime?.sendUserAnswer, "native_runtime_required");
    const grouped = new Map<string, typeof rows>();
    for (const row of rows) {
      const key = args.mode === "individual" ? row.issue.id : row.issue.thread_id;
      grouped.set(key, [...(grouped.get(key) ?? []), row]);
    }
    const noticeThreads = new Set<string>();
    const groups = [...grouped.values()].map((replies) => {
      const thread = replies[0]!.issue.thread_id;
      const notices = noticeThreads.has(thread)
        ? []
        : this.readIssues(args.task, thread).issues.filter(
            (view) =>
              view.state === "已关闭" &&
              view.disposition &&
              !this.db
                .prepare(
                  "SELECT 1 FROM events WHERE task=? AND type='issue_closure_notified' AND json_extract(details,'$.close_id')=?",
                )
                .get(args.task, view.disposition.id),
          );
      noticeThreads.add(thread);
      const text = replies
        .map(({ issue, answer }) => {
          const chars = Array.from(issue.body);
          const body = chars.length > 600 ? chars.slice(0, 599).join("") + "…" : issue.body;
          return `问题 ${issue.number}：${issue.title}\n${body ? body + "\n" : ""}用户答复：${answer}`;
        })
        .join("\n\n");
      return {
        replies,
        thread,
        messageId: randomUUID(),
        bundleId: randomUUID(),
        notices,
        message:
          text +
          notices
            .map(
              (view) =>
                `\n\n（另：你上报的问题 ${view.issue.number} 已被关闭，理由：${view.disposition!.reason ?? view.disposition!.body}。如不同意，请重新上报并补充证据。）`,
            )
            .join(""),
        answers: [] as A2AIssueRecord[],
      };
    });
    const createdAt = new Date(this.now()).toISOString();
    // Input, answer, message registration and derived intervention are atomic.
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const group of groups)
        for (const { issue, answer } of group.replies) {
          const inputId = randomUUID();
          const record: A2AIssueRecord = {
            ...issue,
            id: inputId,
            kind: "answer",
            from: "user",
            to: issue.from,
            reply_to: issue.id,
            created_at: createdAt,
            body: answer,
            input_id: inputId,
            message_id: group.messageId,
            bundle_id: group.bundleId,
            refs: [
              ...issue.refs,
              `issue:${issue.id}`,
              `input:${inputId}`,
              `message:${group.messageId}`,
            ],
          };
          const sequence = this.appendIssue(record);
          this.saveUserInput({
            id: inputId,
            schema: 1,
            form: "answer",
            text: answer,
            target: {
              task: issue.task_id,
              attempt: issue.attempt_id,
              thread: issue.thread_id,
              turn: null,
              message: group.messageId,
            },
            channel: "issue-panel",
            reply_to: issue.id,
            source_ref: {
              message_id: group.messageId,
              event_id: record.id,
              source_sequence: sequence,
            },
            certainty: "observed",
            created_at: createdAt,
            bundle_id: group.bundleId,
            question: { number: issue.number, title: issue.title, body: issue.body },
          });
          if (issue.attempt_id)
            this.event(
              issue.task_id,
              "human_intervention",
              {
                input_id: inputId,
                event_id: inputId,
                task_id: issue.task_id,
                attempt_id: issue.attempt_id,
                thread_id: issue.thread_id,
                message_id: group.messageId,
                dispatch_origin: "user",
                text: group.message,
              },
              issue.attempt_id,
            );
          group.answers.push(record);
        }
      this.db.exec("COMMIT");
    } finally {
      if (this.db.isTransaction) this.db.exec("ROLLBACK");
    }
    for (const group of groups) {
      const current = this.load(args.task).current_attempt;
      const binding = this.ownedThread(group.thread);
      let action: "delivered" | "forward" = "forward";
      if (
        (current &&
          current.thread_id === group.thread &&
          current.attempt_id === group.replies[0]!.issue.attempt_id &&
          !current.reclaimed) ||
        (binding?.attachment && group.replies[0]!.issue.attempt_id === null)
      ) {
        try {
          await this.runtime.sendUserAnswer(group.thread, group.messageId, group.message);
          action = "delivered";
          for (const view of group.notices)
            this.event(
              args.task,
              "issue_closure_notified",
              {
                close_id: view.disposition!.id,
                issue_id: view.issue.id,
                message_id: group.messageId,
              },
              view.issue.attempt_id,
            );
        } catch (error) {
          // Only an explicit terminal receipt permits forwarding. Unknown
          // delivery failures preserve the answer and remain errors.
          if (!(error instanceof Refusal) || error.code !== "session_ended") throw error;
        }
      }
      for (const record of group.answers) {
        const disposition: A2AIssueRecord = {
          ...record,
          id: randomUUID(),
          kind: "disposition",
          from: "system",
          to: action === "forward" ? "executor" : record.to,
          reply_to: record.id,
          body: action === "forward" ? "session-ended" : "",
          ...(action === "forward" ? { reason: "session-ended" } : {}),
          action,
          created_at: new Date(this.now()).toISOString(),
        };
        this.appendIssue(disposition);
        if (action === "forward") await this.deliverInbox(disposition);
      }
    }
    return { ok: true, ...this.readIssues(args.task) };
  }
  private event(task: string, type: string, details: unknown, expectedAttempt?: string | null) {
    this.checkUserInputObserver();
    const row = this.db.prepare("SELECT data FROM tasks WHERE id=?").get(task);
    const current = row ? (JSON.parse(String(row.data)) as A2ATask).current_attempt : null;
    const inserted = this.db
      .prepare("INSERT INTO events(time,task,attempt,type,details) VALUES (?,?,?,?,?)")
      .run(
        new Date().toISOString(),
        task,
        expectedAttempt === undefined ? (current?.attempt_id ?? null) : expectedAttempt,
        type,
        JSON.stringify(details),
      );
    return Number(inserted.lastInsertRowid);
  }
  private load(task: string): A2ATask {
    const row = this.db.prepare("SELECT data FROM tasks WHERE id=?").get(task);
    requireGate(row, "unknown_task");
    return JSON.parse(String(row.data)) as A2ATask;
  }
  private save(
    task: A2ATask,
    type: string,
    details: unknown = task,
    historicalAttempt?: A2AAttempt,
  ) {
    this.checkUserInputObserver();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db
        .prepare(
          "INSERT INTO tasks(id,data) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data",
        )
        .run(task.task_id, JSON.stringify(task));
      if (task.current_attempt)
        this.db
          .prepare(
            "INSERT INTO attempts(id,data) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data",
          )
          .run(task.current_attempt.attempt_id, JSON.stringify(task.current_attempt));
      if (historicalAttempt)
        this.db
          .prepare(
            "INSERT INTO attempts(id,data) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data",
          )
          .run(historicalAttempt.attempt_id, JSON.stringify(historicalAttempt));
      if (task.verification)
        this.db
          .prepare(
            "INSERT INTO verifications(id,data) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data",
          )
          .run(task.verification.verification_id, JSON.stringify(task.verification));
      this.event(task.task_id, type, details, historicalAttempt?.attempt_id);
      this.db.exec("COMMIT");
    } finally {
      if (this.db.isTransaction) this.db.exec("ROLLBACK");
    }
  }
  private async execute(
    task: string,
    argv: string[],
    cwd: string,
    env?: NodeJS.ProcessEnv,
  ): Promise<A2ACommandResult> {
    this.checkUserInputObserver();
    const command = argv[0];
    requireGate(command, "invalid_command");
    this.event(task, "command_intent", { argv, cwd });
    const result = await new Promise<A2ACommandResult>((resolve, reject) => {
      execProcessFile(
        command,
        argv.slice(1),
        { cwd, env, encoding: "utf8", timeout: 60_000, maxBuffer: 4 * 1024 * 1024 },
        (error, stdout, stderr) => {
          const code = error && typeof error.code === "number" ? error.code : error ? null : 0;
          const record: A2ACommandResult = {
            argv,
            cwd,
            stdout,
            stderr,
            exit: code,
            returncode: code,
          };
          try {
            this.event(task, "command_result", record);
          } catch (recordingError) {
            reject(recordingError);
            return;
          }
          if (error && code === null) {
            const refusal = error.killed ? "command_timeout" : "command_unavailable";
            reject(new Refusal(refusal, { ...record, reason: error.message }));
          } else resolve(record);
        },
      );
    });
    return result;
  }
  private async git(
    task: string,
    repo: string,
    args: string[],
    allowed = [0],
    env?: NodeJS.ProcessEnv,
  ) {
    const result = await this.execute(task, ["git", "-C", repo, ...args], repo, env);
    requireGate(
      result.returncode !== null && allowed.includes(result.returncode),
      "git_failed",
      result,
    );
    requireGate(result.stdout !== null, "command_unknown", result);
    return result.stdout.trim();
  }
  private async commitExists(task: string, repo: string, commit: string) {
    sha(commit);
    requireGate(
      (await this.git(task, repo, ["cat-file", "-t", commit], [0, 128])) === "commit",
      "invalid_commit",
    );
  }
  private async ancestor(task: string, repo: string, old: string, candidate: string) {
    const result = await this.execute(
      task,
      ["git", "-C", repo, "merge-base", "--is-ancestor", old, candidate],
      repo,
    );
    requireGate(result.returncode === 0 || result.returncode === 1, "git_failed", result);
    return result.returncode === 0;
  }
  private checkVerification(
    task: A2ATask,
    attempt: A2AAttempt,
    v: A2AVerification | null,
  ): asserts v is A2AVerification {
    requireGate(
      v &&
        v.attempt.task_id === task.task_id &&
        v.attempt.attempt_id === attempt.attempt_id &&
        v.attempt.session_id === attempt.session_id &&
        v.attempt.fence === attempt.fence &&
        v.attempt.spec_rev === attempt.spec_rev &&
        v.attempt.base_commit === attempt.base_commit &&
        v.spec_rev === task.spec_rev &&
        v.C === task.candidate_commit &&
        v.oracle === task.oracle,
      "stale_verification",
    );
    const row = this.db.prepare("SELECT data FROM verifications WHERE id=?").get(v.verification_id);
    requireGate(row && String(row.data) === JSON.stringify(v), "stale_verification");
  }
  private interruptVerification(task: A2ATask) {
    if (task.state !== "verifying") return;
    const v = task.verification;
    this.checkVerification(task, this.current(task), v);
    requireGate(v.state === "running" && !task.integration_intent, "needs_reconciliation");
    v.state = "interrupted";
    v.ended = new Date().toISOString();
    v.result ??= {
      argv: v.command_intent?.argv ?? [],
      cwd: v.workspace,
      exit: null,
      returncode: null,
      stdout: null,
      stderr: null,
      outcome: "unknown",
    };
    task.state = "submitted";
    this.save(task, "verification_interrupted", v);
  }
  private invalidate(task: A2ATask, reason: string) {
    this.interruptVerification(task);
    const previous = task.current_attempt;
    if (previous) {
      previous.state = "revoked";
      previous.revocation_reason = reason;
    }
    task.current_attempt = null;
    task.state = "ready";
    task.candidate_commit = null;
    task.verification = null;
    task.integration_intent = null;
    this.save(
      task,
      "revoked",
      { reason, attempt: previous?.attempt_id, spec_rev: task.spec_rev },
      previous ?? undefined,
    );
  }
  private async integration(task: A2ATask) {
    return this.git(task.task_id, task.repo, ["rev-parse", "--verify", "--quiet", REF], [0, 1]);
  }
  private current(task: A2ATask, expected?: string) {
    const attempt = task.current_attempt;
    requireGate(attempt && (!expected || attempt.attempt_id === expected), "stale_attempt");
    requireGate(
      attempt.task_id === task.task_id &&
        attempt.fence === task.fence &&
        attempt.spec_rev === task.spec_rev,
      "stale_attempt",
    );
    return attempt;
  }

  private saveRun(run: A2ARun, type: string) {
    this.checkUserInputObserver();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db
        .prepare(
          "INSERT INTO runs(id,task,data) VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data",
        )
        .run(run.run_id, run.task_id, JSON.stringify(run));
      this.event(run.task_id, type, run, run.attempt_id ?? undefined);
      this.db.exec("COMMIT");
    } finally {
      if (this.db.isTransaction) this.db.exec("ROLLBACK");
    }
  }
  private checkThread(attempt: A2AAttempt, live: Awaited<ReturnType<GateRuntime["readThread"]>>) {
    requireGate(
      live.workspace === attempt.workspace &&
        live.provider === "codex" &&
        (!attempt.turn_id || live.turn === attempt.turn_id),
      "identity_conflict",
      { attempt, live },
    );
  }
  private checkErrorReclaim(live: Awaited<ReturnType<GateRuntime["readThread"]>>) {
    requireGate(
      !live.error ||
        (live.error.providerPresent === false &&
          live.error.activeTurn === null &&
          live.running === false &&
          live.blocked === false),
      "run_external_unknown",
      live,
    );
  }
  private async observeRun(run: A2ARun) {
    this.checkUserInputObserver();
    const attempt = this.current(this.load(run.task_id), run.attempt_id!);
    let live: Awaited<ReturnType<GateRuntime["readThread"]>>;
    try {
      live = await this.runtime!.readThread(attempt.thread_id);
    } catch (error) {
      this.current(this.load(run.task_id), run.attempt_id!);
      if (error instanceof Refusal) throw error;
      throw new Refusal("run_external_unknown", String(error));
    }
    this.current(this.load(run.task_id), run.attempt_id!);
    this.checkThread(attempt, live);
    requireGate(!live.error, "run_external_unknown", live);
    requireGate(!live.blocked, "run_blocked", live);
    requireGate(!live.archived && !live.stopped, "run_external_unknown", live);
    if (!attempt.turn_id && live.turn) {
      // Binding is an ordinary task mutation. Refuse a concurrent gate owner.
      const lock = new DatabaseSync(join(this.root, "locks", `${run.task_id}.sqlite3`));
      try {
        lock.exec("PRAGMA busy_timeout=0; BEGIN IMMEDIATE");
        const task = this.load(run.task_id);
        const current = this.current(task, run.attempt_id!);
        requireGate(!current.turn_id || current.turn_id === live.turn, "identity_conflict");
        current.turn_id = live.turn;
        this.save(task, "turn_bound", { attempt: current });
      } finally {
        lock.close();
      }
    }
    return live;
  }
  private async waitForIdle(run: A2ARun) {
    const deadline = performance.now() + 60_000;
    for (;;) {
      const row = this.db.prepare("SELECT data FROM attempts WHERE id=?").get(run.attempt_id!);
      requireGate(row, "unknown_attempt");
      const attempt = JSON.parse(String(row.data)) as A2AAttempt;
      requireGate(
        attempt.task_id === run.task_id && attempt.thread_id === run.thread_id,
        "identity_conflict",
      );
      if (attempt.reclaimed) return;
      const live = await this.runtime!.readThread(attempt.thread_id);
      this.checkThread(attempt, live);
      requireGate(!live.error, "run_external_unknown", live);
      requireGate(!live.blocked, "run_blocked", live);
      if (!live.running) return;
      requireGate(performance.now() < deadline, "run_reclaim_deadline", live);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  private async run(args: A2AGateRequest): Promise<A2AGateResult> {
    requireGate(Number.isSafeInteger(args.wait_seconds) && args.wait_seconds! > 0, "invalid_wait");
    requireGate(args.runtimeMode, "runtime_mode_required");
    requireGate(this.runtime, "runtime_required");
    this.load(args.task);
    const lock = new DatabaseSync(join(this.root, "locks", `${args.task}.run.sqlite3`));
    let run: A2ARun | undefined;
    try {
      lock.exec("PRAGMA busy_timeout=0");
      try {
        lock.exec("BEGIN IMMEDIATE");
      } catch (error) {
        if (
          (error as { errcode?: number }).errcode === 5 ||
          (error as Error).message.includes("database is locked")
        )
          throw new Refusal("run_busy");
        throw error;
      }
      run = {
        run_id: randomUUID(),
        task_id: args.task,
        attempt_id: null,
        thread_id: null,
        started: new Date().toISOString(),
        wait_seconds: args.wait_seconds!,
        phase: "dispatching",
        outcome: "running",
      };
      this.saveRun(run, "run_started");
      const dispatch = await this.request(
        { command: "dispatch", task: args.task, runtimeMode: args.runtimeMode },
        undefined,
        run,
      );
      requireGate(dispatch.ok, dispatch.error ?? "gate_failure", dispatch.details);
      run.phase = "waiting_submit";
      this.saveRun(run, "run_phase");
      const deadline = performance.now() + args.wait_seconds! * 1000;
      let previous = "";
      for (;;) {
        this.current(this.load(args.task), run.attempt_id!);
        requireGate(performance.now() < deadline, "run_deadline");
        const live = await this.observeRun(run);
        const task = this.load(args.task);
        const change = JSON.stringify({
          task_state: task.state,
          turn: live.turn,
          running: live.running,
          blocked: live.blocked ?? false,
        });
        if (change !== previous) {
          this.event(
            args.task,
            "run_observed",
            { run_id: run.run_id, live, task_state: task.state },
            run.attempt_id!,
          );
          previous = change;
        }
        requireGate(performance.now() < deadline, "run_deadline");
        requireGate(["claimed", "submitted"].includes(task.state), "run_state_changed", task.state);
        if (task.state === "submitted") break;
        await new Promise((resolve) =>
          setTimeout(resolve, Math.min(100, Math.max(0, deadline - performance.now()))),
        );
      }
      for (const command of ["verify", "integrate"] as const) {
        run.phase = command === "verify" ? "verifying" : "integrating";
        this.saveRun(run, "run_phase");
        const result = await this.request({ command, task: args.task, attempt: run.attempt_id! });
        requireGate(result.ok, result.error ?? "gate_failure", result.details);
      }
      run.phase = "reclaiming";
      this.saveRun(run, "run_phase");
      await this.waitForIdle(run);
      const cleanup = await this.request({
        command: "reclaim",
        task: args.task,
        attempt: run.attempt_id!,
      });
      requireGate(cleanup.ok, "run_reclaim_failed", cleanup);
      run.reclaimed = true;
      run.outcome = "completed";
      run.ended = new Date().toISOString();
      this.saveRun(run, "run_finished");
      return { ok: true, task: this.load(args.task), run };
    } catch (error) {
      if (!run) throw error;
      const code =
        error instanceof Refusal
          ? error.code === "stale_attempt"
            ? "run_superseded"
            : error.code
          : "run_external_unknown";
      const details = error instanceof Refusal ? error.details : String(error);
      if (
        run.attempt_id &&
        ["run_deadline", "run_superseded", "oracle_failed", "merge_failed"].includes(code)
      ) {
        try {
          await this.waitForIdle(run);
          const cleanup = await this.request({
            command: "reclaim",
            task: args.task,
            attempt: run.attempt_id,
          });
          requireGate(cleanup.ok, cleanup.error ?? "run_reclaim_failed", cleanup.details);
          run.reclaimed = true;
        } catch (cleanup) {
          run.cleanup_failure =
            cleanup instanceof Refusal
              ? { error: cleanup.code, details: cleanup.details }
              : String(cleanup);
        }
      }
      run.error = code;
      run.details = details;
      run.outcome =
        code === "run_deadline"
          ? "deadline"
          : code === "run_superseded"
            ? "superseded"
            : ["oracle_failed", "merge_failed"].includes(code)
              ? "verification_failed"
              : run.phase === "reclaiming"
                ? "integrated_reclaim_failed"
                : "paused";
      run.ended = new Date().toISOString();
      if (this.userInputObserver?.state === "failed") {
        // The write that failed may also prevent a final receipt. Keep the last
        // durable phase and expose the pause; never invent persisted evidence.
        return { ok: false, error: code, details, run };
      }
      this.saveRun(run, "run_finished");
      return { ok: false, error: code, details, task: this.load(args.task), run };
    } finally {
      lock.close();
    }
  }

  private inboxRecords(): A2AInboxEntry[] {
    return [
      ...this.db.prepare("SELECT data FROM inbox_records ORDER BY rowid").all(),
      ...this.db.prepare("SELECT data FROM issue_records ORDER BY rowid").all(),
    ].map((row) => JSON.parse(String(row.data)) as A2AInboxEntry);
  }
  private inboxEntry(entryId: string): A2AInboxEntry {
    const entry = this.inboxRecords().find((record) => record.id === entryId);
    requireGate(entry, "unknown_inbox_entry");
    return entry;
  }
  private inboxConfirmed(entryId: string, role: string): boolean {
    return this.inboxRecords().some(
      (record) => record.kind === "ack" && record.from === role && record.reply_to === entryId,
    );
  }
  private inboxIssueWaiting(issue: A2AInboxEntry, records: ReadonlyArray<A2AInboxEntry>): boolean {
    const native = this.db.prepare("SELECT task FROM issue_records WHERE id=?").get(issue.id);
    if (native)
      return (
        this.readIssues(String(native.task)).issues.find((view) => view.issue.id === issue.id)
          ?.state === "等你决定"
      );
    const last = records
      .filter(
        (entry) =>
          (entry.kind === "disposition" || entry.kind === "answer") &&
          (entry.reply_to === issue.id || entry.refs.includes(`issue:${issue.id}`)),
      )
      .at(-1);
    if (!last)
      return Boolean(issue.blocking) || this.now() - Date.parse(issue.created_at) >= 900_000;
    if (last.kind === "answer" || ["close", "dismiss", "delivered"].includes(last.action ?? ""))
      return false;
    if (last.action === "forward") return this.now() - Date.parse(last.created_at) >= 900_000;
    if (last.action === "snooze") return this.now() - Date.parse(last.created_at) >= 3_600_000;
    return true;
  }
  private appendInbox(entry: A2AInboxEntry): void {
    this.db
      .prepare("INSERT INTO inbox_records(id,data) VALUES (?,?)")
      .run(entry.id, JSON.stringify(entry));
  }
  private inboxDelivery(entry: string): A2AInboxDelivery | undefined {
    const row = this.db
      .prepare("SELECT data FROM inbox_deliveries WHERE entry=? ORDER BY seq DESC LIMIT 1")
      .get(entry);
    return row ? (JSON.parse(String(row.data)) as A2AInboxDelivery) : undefined;
  }
  private appendDelivery(receipt: A2AInboxDelivery): void {
    this.db
      .prepare("INSERT INTO inbox_deliveries(entry,data) VALUES (?,?)")
      .run(receipt.entry_id, JSON.stringify(receipt));
  }
  private ownedThread(thread: string) {
    const task = this.taskForThread(thread);
    if (task?.current_attempt && !task.current_attempt.reclaimed)
      return { task, role: "worker", attempt: task.current_attempt };
    const row = this.db.prepare("SELECT data FROM attachments WHERE id=?").get(thread);
    const attached = row ? (JSON.parse(String(row.data)) as A2AAttachment) : undefined;
    if (attached?.state === "active")
      return { task: this.load(attached.task_id), role: attached.role, attachment: attached };
    return undefined;
  }
  private async deliverInbox(entry: A2AInboxEntry): Promise<A2AInboxDelivery> {
    const lock = this.operationLock(`inbox-${entry.id}`);
    try {
      const previous = this.inboxDelivery(entry.id);
      // A persisted pending receipt is unknown, not permission to send again.
      if (previous) return previous;
      const created_at = new Date(this.now()).toISOString();
      this.appendDelivery({ state: "pending", entry_id: entry.id, created_at });
      let receipt: A2AInboxDelivery;
      try {
        requireGate(this.runtime?.wakeThread, "wake_runtime_required");
        const targets = this.membership
          .presetThreads(entry.to)
          .filter((thread) => this.ownedThread(thread));
        if (entry.to.includes(":")) {
          const [role, thread] = entry.to.split(":");
          if (thread && this.ownedThread(thread)?.role === role) targets.push(thread);
        }
        requireGate(
          targets.length === 1,
          targets.length ? "ambiguous_role_session" : "role_session_missing",
        );
        const thread = targets[0]!;
        const result = await this.runtime.wakeThread(thread, entry);
        receipt = {
          state: "delivered",
          entry_id: entry.id,
          created_at: new Date(this.now()).toISOString(),
          thread,
          message: result.message,
        };
      } catch (error) {
        // Delivery is the external boundary. Preserve the entry and a failure
        // receipt, without a retry, replacement target, or success claim.
        receipt = {
          state: error instanceof Refusal ? "undelivered" : "unknown",
          entry_id: entry.id,
          created_at: new Date(this.now()).toISOString(),
          reason: error instanceof Refusal ? error.code : String(error),
        };
      }
      this.appendDelivery(receipt);
      return receipt;
    } finally {
      lock.close();
    }
  }
  private async inboxCall(args: A2AInboxRequest, caller?: SubmitCaller): Promise<A2AGateResult> {
    const role = caller?.address ?? args.role ?? args.from ?? "user";
    requireGate(
      /^(?:user|ideation|executor|system|triage|(?:worker|reviewer|monitor):[A-Za-z0-9_.-]+)$/.test(
        role,
      ),
      "invalid_address",
    );
    if (caller && args.command !== "inbox_list") await caller.assertActive();
    if (args.command === "inbox_list") {
      const records = this.inboxRecords();
      return {
        ok: true,
        entries: records
          .filter(
            (entry) =>
              entry.kind !== "ack" &&
              (role === "user"
                ? entry.kind === "issue" && this.inboxIssueWaiting(entry, records)
                : (entry.to === role ||
                    (entry.kind === "issue" &&
                      entry.to === "triage" &&
                      ["ideation", "executor"].includes(role))) &&
                  !this.inboxConfirmed(entry.id, role)),
          )
          .map((entry) => {
            const delivery = this.inboxDelivery(entry.id);
            return { entry, ...(delivery ? { delivery } : {}) };
          }),
      };
    }
    this.checkUserInputObserver();
    if (args.command === "inbox_ack" || args.kind === "ack") {
      const original = this.inboxEntry(args.id ?? args.reply_to ?? "");
      requireGate(original.kind !== "ack", "ack_is_terminal");
      requireGate(original.to === role, "recipient_required");
      if (args.command === "inbox_send")
        requireGate(args.to === original.from, "recipient_required");
      const lock = this.operationLock(`inbox-${original.id}`);
      let ack: A2AInboxEntry;
      try {
        const previous = this.inboxRecords().find(
          (entry) => entry.kind === "ack" && entry.from === role && entry.reply_to === original.id,
        );
        if (previous) {
          const delivery = this.inboxDelivery(previous.id);
          return {
            ok: delivery?.state === "delivered",
            entry: previous,
            ...(delivery ? { delivery } : {}),
            ...(delivery?.state !== "delivered" ? { error: "wake_undelivered" } : {}),
          };
        }
        ack = {
          id: randomUUID(),
          schema: 1,
          kind: "ack",
          from: role,
          to: original.from,
          reply_to: original.id,
          refs: [],
          created_at: new Date(this.now()).toISOString(),
          body: args.body ?? "确认收到。",
        };
        this.appendInbox(ack);
      } finally {
        lock.close();
      }
      const delivery = await this.deliverInbox(ack);
      return {
        ok: delivery.state === "delivered",
        entry: ack,
        delivery,
        ...(delivery.state !== "delivered" ? { error: "wake_undelivered" } : {}),
      };
    }
    requireGate(
      !args.id && args.kind && args.to && args.body !== undefined,
      "inbox_arguments_required",
    );
    const handoffDirections: Partial<Record<A2AInboxEntry["kind"], readonly [string, string]>> = {
      assign: ["ideation", "executor"],
      revise: ["ideation", "executor"],
      cancel: ["ideation", "executor"],
      report: ["executor", "ideation"],
      "needs-decision": ["executor", "ideation"],
    };
    const direction = handoffDirections[args.kind];
    if (direction)
      requireGate(role === direction[0] && args.to === direction[1], "invalid_direction");
    if (args.kind === "issue")
      requireGate(
        /^(?:worker|reviewer|monitor):/.test(role) && args.to === "triage",
        "invalid_direction",
      );
    requireGate(
      /^(?:user|ideation|executor|system|triage|(?:worker|reviewer|monitor):[A-Za-z0-9_.-]+)$/.test(
        args.to,
      ),
      "invalid_address",
    );
    requireGate(
      (args.refs ?? []).every((ref) =>
        /^(?:ticket|task|attempt|thread|turn|message|request|input|issue|file|commit|worker):.+$/.test(
          ref,
        ),
      ),
      "invalid_reference",
    );
    const parent = args.reply_to ? this.inboxEntry(args.reply_to) : undefined;
    if (args.kind === "issue")
      requireGate(args.title?.trim() && args.to === "triage", "invalid_issue");
    else requireGate(!args.blocking, "blocking_only_for_issue");
    if (args.kind !== "answer")
      requireGate(
        args.certainty === undefined && args.bundle_id === undefined,
        "answer_fields_only_for_answer",
      );
    if (args.kind !== "disposition")
      requireGate(
        args.action === undefined && args.reason === undefined && args.basis === undefined,
        "disposition_fields_only_for_disposition",
      );
    if (args.kind === "disposition") {
      requireGate(parent?.kind === "issue" && args.action, "disposition_requires_issue");
      requireGate(
        ["executor", "ideation", "user", "system"].includes(role),
        "disposition_sender_required",
      );
      if (args.action === "close" || args.action === "dismiss")
        requireGate(!parent.blocking || role === "user", "blocking_requires_user");
      if (args.action === "dismiss") requireGate(role === "user", "user_required");
      if (args.action === "close")
        requireGate(args.reason?.trim() && args.basis?.trim(), "close_requires_reason_basis");
      const legacy = this.db.prepare("SELECT data FROM issue_records WHERE id=?").get(parent.id);
      if (legacy) {
        const issue = JSON.parse(String(legacy.data)) as A2AIssueRecord;
        if (caller) requireGate(["ideation", "executor"].includes(role), "controller_required");
        const lock = this.operationLock(issue.task_id);
        try {
          const result = await this.disposeIssue(
            {
              command: "disposition",
              task: issue.task_id,
              issue: issue.id,
              action: args.action,
              reason: args.reason,
              basis: args.basis,
              body: args.body,
            },
            caller,
            role,
          );
          return {
            ...result,
            ...(result.delivery?.state !== "delivered" && result.delivery
              ? { ok: false, error: "wake_undelivered" }
              : {}),
          };
        } finally {
          lock.close();
        }
      }
    }
    if (args.kind === "stop")
      requireGate(
        ["ideation", "user"].includes(role) && args.to === "executor",
        "invalid_stop_sender",
      );
    if (args.kind === "answer")
      requireGate(role === "ideation" && args.to === "executor", "invalid_answer_sender");
    const entry: A2AInboxEntry = {
      id: randomUUID(),
      schema: 1,
      kind: args.kind,
      from: role,
      to: args.to,
      reply_to: parent?.id ?? null,
      refs: args.refs ?? [],
      created_at: new Date(this.now()).toISOString(),
      body: args.body,
      ...(args.title !== undefined ? { title: args.title } : {}),
      ...(args.kind === "issue" ? { blocking: args.blocking ?? false } : {}),
      ...(args.action ? { action: args.action } : {}),
      ...(args.reason !== undefined ? { reason: args.reason } : {}),
      ...(args.basis !== undefined ? { basis: args.basis } : {}),
      ...(args.kind === "answer"
        ? { certainty: "relayed", bundle_id: args.bundle_id ?? randomUUID() }
        : {}),
    };
    this.appendInbox(entry);
    const delivery = await this.deliverInbox(entry);
    return {
      ok: delivery.state === "delivered",
      entry,
      delivery,
      ...(delivery.state !== "delivered" ? { error: "wake_undelivered" } : {}),
    };
  }
  private async emergencyStop(args: A2AStopRequest, caller?: SubmitCaller): Promise<A2AGateResult> {
    if (caller) {
      requireGate(caller.address === "ideation", "ideation_required");
      await caller.assertActive();
    }
    const stop = this.inboxEntry(args.stop_id);
    requireGate(
      stop.kind === "stop" && stop.to === "executor" && ["user", "ideation"].includes(stop.from),
      "stop_entry_required",
    );
    const target = this.ownedThread(args.thread);
    requireGate(
      target && ["worker", "reviewer", "monitor"].includes(target.role),
      "worker_target_required",
    );
    const taskLock = this.operationLock(target.task.task_id);
    let entryLock: DatabaseSync | undefined;
    try {
      entryLock = this.operationLock(`inbox-${stop.id}`);
      requireGate(this.now() - Date.parse(stop.created_at) > 120_000, "stop_too_early");
      requireGate(!this.inboxConfirmed(stop.id, "executor"), "stop_already_acknowledged");
      requireGate(
        stop.refs.includes(`thread:${args.thread}`) ||
          (target.attempt && stop.refs.includes(`attempt:${target.attempt.attempt_id}`)),
        "stop_target_mismatch",
      );
      requireGate(this.runtime?.interruptThread, "interrupt_runtime_required");
      const live = await this.runtime.readThread(args.thread);
      requireGate(
        !live.archived &&
          !live.error &&
          live.workspace === (target.attempt?.workspace ?? target.task.repo) &&
          live.provider === (target.attachment?.modelSelection.provider ?? "codex"),
        "identity_conflict",
      );
      if (caller) await caller.assertActive();
      this.checkUserInputObserver();
      await this.runtime.interruptThread(args.thread);
      this.event(
        target.task.task_id,
        "emergency_interrupt_requested",
        { stop_id: stop.id, thread: args.thread, actor: caller?.address ?? "user" },
        target.attempt?.attempt_id ?? null,
      );
      return { ok: true, interruptRequested: true };
    } finally {
      entryLock?.close();
      taskLock.close();
    }
  }
  async call(raw: unknown, caller?: SubmitCaller): Promise<A2AGateResult> {
    const command = (raw as { command?: unknown } | null)?.command;
    if (typeof command === "string" && (command.startsWith("inbox_") || command === "stop")) {
      try {
        return command === "stop"
          ? await this.emergencyStop(Schema.decodeUnknownSync(A2AStopRequest)(raw), caller)
          : await this.inboxCall(Schema.decodeUnknownSync(A2AInboxRequest)(raw), caller);
      } catch (error) {
        return {
          ok: false,
          error: error instanceof Refusal ? error.code : "invalid_request",
          details: String(error),
        };
      }
    }
    const result = await this.request(raw, caller);
    const observer = this.userInputObserverStatus();
    return { ...result, ...(observer ? { user_input_observer: observer } : {}) };
  }

  private async request(raw: unknown, caller?: SubmitCaller, run?: A2ARun): Promise<A2AGateResult> {
    let taskId: string | undefined;
    let lock: DatabaseSync | undefined;
    try {
      const args = Schema.decodeUnknownSync(A2AGateRequest)(raw);
      taskId = id(args.task);
      if (args.attempt !== undefined) id(args.attempt);
      if (args.session !== undefined) id(args.session);
      if (args.command === "status")
        return { ok: true, task: this.load(taskId), ...this.readIssues(taskId) };
      if (args.command === "issues") {
        this.load(taskId);
        return { ok: true, ...this.readIssues(taskId, args.thread) };
      }
      if (args.command === "events") {
        const rows = this.db
          .prepare(
            "SELECT seq,time,task,attempt,type,details FROM events WHERE task=? ORDER BY seq",
          )
          .all(taskId);
        return {
          ok: true,
          events: rows.map((r) => ({
            seq: Number(r.seq),
            time: String(r.time),
            task: String(r.task),
            attempt: r.attempt === null ? null : String(r.attempt),
            type: String(r.type),
            details: JSON.parse(String(r.details)) as unknown,
          })),
        };
      }
      if (caller) {
        if (caller.address === "executor") await caller.assertActive();
        else if (args.command !== "disposition")
          requireGate(
            args.command === "submit" && this.taskForThread(caller.thread)?.task_id === taskId,
            "stale_thread",
          );
      }
      this.checkUserInputObserver();
      if (args.command === "run") return await this.run(args);
      // A separate SQLite write transaction is the OS-released task operation lock.
      // Keep the inode, never unlink it. Main-state reads remain available during an oracle.
      lock = this.operationLock(taskId);
      if (args.command === "disposition") {
        if (caller) {
          const member = this.membership
            .list()
            .find((entry) => entry.taskId === taskId)
            ?.members.find((entry) => entry.threadId === caller.thread);
          requireGate(
            (member?.role === "controller" && !member.endedAt) ||
              (["ideation", "executor"].includes(caller.address ?? "") &&
                this.ownedThread(caller.thread)?.role === "controller"),
            "controller_required",
          );
          await caller.assertActive();
          requireGate(this.runtime, "native_runtime_required");
          const live = await this.runtime.readThread(caller.thread);
          requireGate(
            !live.error &&
              !live.archived &&
              !live.blocked &&
              live.running &&
              live.turn === caller.turn,
            "identity_conflict",
          );
          await caller.assertActive();
        }
        return await this.disposeIssue(args, caller);
      }
      if (args.command === "answer_issue" || args.command === "answer_issues")
        return await this.answerIssues(args);
      if (args.command === "create") {
        requireGate(!this.db.prepare("SELECT 1 FROM tasks WHERE id=?").get(taskId), "task_exists");
        const repo = inputPath(args.repo, true),
          oracle = inputPath(args.oracle),
          instructions = inputPath(args.instructions),
          base = sha(args.base);
        requireGate(
          (await this.git(taskId, repo, ["rev-parse", "--show-toplevel"])) === repo,
          "invalid_repo",
        );
        await this.commitExists(taskId, repo, base);
        const snapshot = join(this.root, "tasks", `${taskId}-${randomUUID()}`);
        const task: A2ATask = {
          task_id: taskId,
          title: text(args.title ?? taskId),
          project_id: id(args.project ?? (this.runtime ? undefined : taskId)),
          repo,
          oracle: join(snapshot, "oracle.py"),
          instructions: join(snapshot, "instructions.txt"),
          base_commit: base,
          state: "creating",
          spec_rev: 1,
          fence: 0,
          current_attempt: null,
          candidate_commit: null,
          verification: null,
          integration_intent: null,
        };
        requireGate(task.title!.length <= 240, "invalid_title");
        const membership = this.membership.list().find((item) => item.taskId === taskId);
        requireGate(
          !membership || membership.projectId === task.project_id,
          "gate_project_mismatch",
        );
        const actual = await this.integration(task);
        requireGate(!actual || actual === base, "integration_conflict");
        const instructionBytes = readFileSync(instructions);
        new TextDecoder("utf-8", { fatal: true }).decode(instructionBytes);
        const oracleBytes = readFileSync(oracle);
        this.save(task, "create_intent", {
          task,
          oracle_source: oracle,
          instructions_source: instructions,
        });
        mkdirSync(snapshot, { recursive: true });
        writeFileSync(task.oracle, oracleBytes, { flag: "wx", mode: 0o400 });
        writeFileSync(task.instructions, instructionBytes, { flag: "wx", mode: 0o400 });
        if (!actual)
          await this.git(taskId, repo, ["update-ref", REF, base, "0".repeat(base.length)]);
        requireGate((await this.integration(task)) === base, "integration_conflict");
        this.checkUserInputObserver();
        await this.runtime?.ensureProject(task.project_id, repo);
        this.taskMembership(task);
        task.state = "ready";
        this.save(task, "created");
        return { ok: true, task };
      }
      const task = this.load(taskId);
      if (args.command === "attach") {
        requireGate(this.runtime?.createAttachedThread, "runtime_required");
        requireGate(
          args.role && args.modelSelection && args.runtimeMode,
          "attachment_arguments_required",
        );
        const prompt = readFileSync(inputPath(args.instructions), "utf8");
        requireGate(prompt.trim(), "invalid_text");
        const preset = args.preset ?? (args.role !== "controller" ? args.role : undefined);
        if (preset)
          requireGate(
            args.role === (preset === "ideation" || preset === "executor" ? "controller" : preset),
            "preset_role_mismatch",
          );
        const attachment: A2AAttachment = {
          task_id: taskId,
          thread_id: randomUUID(),
          role: args.role,
          ...(preset ? { preset } : {}),
          modelSelection: args.modelSelection,
          runtime_mode: args.runtimeMode,
          state: "creating",
        };
        this.saveAttachment(attachment);
        if (preset) this.membership.bindPreset(attachment.thread_id, preset);
        await this.runtime.createAttachedThread(task, attachment, prompt);
        this.member(task, attachment.thread_id, attachment.role);
        attachment.state = "active";
        this.saveAttachment(attachment);
        this.event(taskId, "attached", { attachment, prompt }, null);
        return { ok: true, task, attachment };
      }
      if (args.command === "reclaim" && args.thread !== undefined) {
        requireGate(!args.attempt, "ambiguous_reclaim");
        const thread = id(args.thread);
        const row = this.db.prepare("SELECT data FROM attachments WHERE id=?").get(thread);
        requireGate(row, "unknown_attachment");
        const attachment = JSON.parse(String(row.data)) as A2AAttachment;
        requireGate(attachment.task_id === taskId, "stale_thread");
        requireGate(this.runtime, "runtime_required");
        if (attachment.state === "ended") {
          requireGate(attachment.ended_at, "reclaim_unconfirmed");
          this.member(task, thread, attachment.role, attachment.ended_at);
          return { ok: true, task, attachment };
        }
        const live = await this.runtime.readThread(thread);
        requireGate(
          live.workspace === task.repo && live.provider === attachment.modelSelection.provider,
          "identity_conflict",
        );
        this.checkErrorReclaim(live);
        requireGate(!live.blocked, "run_blocked", live);
        requireGate(!live.running, "worker_working");
        this.event(taskId, "attachment_reclaim_intent", { attachment, live }, null);
        let archived = live;
        // A failed bookkeeping write may follow confirmed native stop/archive.
        // Reconcile those observed facts without repeating the external effects.
        if (!(live.stopped && live.archived)) {
          await this.runtime.stopThread(thread);
          const stopped = await this.runtime.readThread(thread);
          requireGate(
            stopped.workspace === task.repo &&
              stopped.provider === attachment.modelSelection.provider &&
              stopped.stopped,
            "stop_unconfirmed",
          );
          await this.runtime.archiveThread(thread);
          archived = await this.runtime.readThread(thread);
        }
        requireGate(
          archived.workspace === task.repo &&
            archived.provider === attachment.modelSelection.provider &&
            archived.stopped &&
            archived.archived,
          "reclaim_unconfirmed",
        );
        attachment.state = "ended";
        attachment.ended_at = new Date().toISOString();
        this.db.exec("BEGIN IMMEDIATE");
        try {
          this.saveAttachment(attachment);
          this.event(taskId, "attachment_reclaimed", { attachment, archived }, null);
          this.db.exec("COMMIT");
        } finally {
          if (this.db.isTransaction) this.db.exec("ROLLBACK");
        }
        this.member(task, thread, attachment.role, attachment.ended_at);
        return { ok: true, task, attachment };
      }
      if (args.command === "revoke" || args.command === "revise") {
        requireGate(task.state !== "accepted", "already_accepted");
        requireGate(!task.integration_intent, "needs_reconciliation");
        const reason = args.command === "revoke" ? text(args.reason) : "spec revised";
        if (args.command === "revise")
          requireGate(
            Number.isSafeInteger(args.spec_rev) && args.spec_rev! > task.spec_rev,
            "stale_spec",
          );
        // Retain the interrupted record under its old spec before revising.
        this.interruptVerification(task);
        if (args.command === "revise") task.spec_rev = args.spec_rev!;
        this.invalidate(task, reason);
        return { ok: true, task };
      }
      if (args.command === "dispatch" || args.command === "claim") {
        if (args.command === "dispatch") {
          requireGate(this.runtime, "runtime_required");
          requireGate(args.runtimeMode, "runtime_mode_required");
        }
        const owner = text(args.command === "claim" ? args.owner : taskId);
        requireGate(task.state === "ready" && !task.current_attempt, "already_claimed");
        const base =
          args.command === "dispatch" ? sha(await this.integration(task)) : task.base_commit;
        const attempt: A2AAttempt = {
          task_id: taskId,
          attempt_id: randomUUID(),
          session_id: randomUUID(),
          fence: task.fence + 1,
          spec_rev: task.spec_rev,
          thread_id: args.command === "dispatch" ? randomUUID() : "",
          runtime_mode: args.runtimeMode ?? "approval-required",
          turn_id: null,
          workspace: "",
          base_commit: base,
          reclaimed: false,
          owner,
          state: "preparing",
        };
        attempt.workspace = join(this.root, "worktrees", attempt.attempt_id);
        task.current_attempt = attempt;
        task.fence = attempt.fence;
        task.state = "preparing";
        this.save(task, args.command === "dispatch" ? "dispatch_intent" : "claim_intent", {
          attempt,
          ...(args.command === "dispatch"
            ? { model: "gpt-6.1-sol", reasoning_effort: "xhigh", requested_service_tier: "fast" }
            : {}),
        });
        if (run) {
          run.attempt_id = attempt.attempt_id;
          run.thread_id = attempt.thread_id;
          this.saveRun(run, "run_bound");
        }
        mkdirSync(join(this.root, "worktrees"), { recursive: true });
        try {
          await this.git(taskId, task.repo, [
            "worktree",
            "add",
            "--detach",
            attempt.workspace,
            base,
          ]);
        } catch (error) {
          task.state = "paused";
          attempt.state = "worktree_failed";
          this.save(task, "worktree_failed", { reason: String(error) });
          throw new Refusal("worktree_failed");
        }
        if (args.command === "dispatch") {
          this.checkUserInputObserver();
          await this.runtime!.createThread(task, attempt);
          this.member(task, attempt.thread_id, "worker");
          this.membership.bindPreset(attempt.thread_id, "worker");
          const live = await this.runtime!.readThread(attempt.thread_id);
          this.checkThread(attempt, live);
          requireGate(!live.blocked, "run_blocked", live);
        }
        attempt.state = "claimed";
        task.state = "claimed";
        this.save(task, "claimed");
        if (args.command === "claim") return { ok: true, attempt };
        const submit = {
          command: "submit",
          task: taskId,
          attempt: attempt.attempt_id,
          session: attempt.session_id,
          fence: attempt.fence,
          spec_rev: attempt.spec_rev,
          commit: "<FULL_COMMIT_SHA>",
        };
        const prompt = `${readFileSync(task.instructions, "utf8")}\n\nManaged attempt identity: ${JSON.stringify(submit)}\nAfter implementing and committing, explicitly call the a2a_submit MCP tool with this identity and your full commit SHA. Never submit passed=true. Only this tool delivers your work; turn completion does not. Do not modify the contract or any acceptance tool. If any unexpected approval is requested, stop and report it.`;
        this.event(taskId, "prompt_intent", { thread: attempt.thread_id, prompt });
        this.checkUserInputObserver();
        await this.runtime!.startThread(task, attempt, prompt);
        const live = await this.runtime!.readThread(attempt.thread_id);
        this.checkThread(attempt, live);
        attempt.turn_id = live.turn;
        this.save(task, "dispatched", { attempt });
        return { ok: true, task, attempt };
      }
      let historicalAttempt: A2AAttempt | undefined;
      if (
        args.command === "reclaim" &&
        args.attempt &&
        task.current_attempt?.attempt_id !== args.attempt
      ) {
        const row = this.db.prepare("SELECT data FROM attempts WHERE id=?").get(id(args.attempt));
        requireGate(row, "unknown_attempt");
        const previous = JSON.parse(String(row.data)) as A2AAttempt;
        requireGate(previous.task_id === taskId, "stale_attempt");
        if (previous.reclaimed) return { ok: true, task };
        historicalAttempt = previous;
      }
      if (args.attempt && !historicalAttempt)
        requireGate(task.current_attempt?.attempt_id === args.attempt, "stale_attempt");
      if (args.command === "verify")
        requireGate(task.state === "submitted" || task.state === "verifying", "not_submitted");
      if (args.command === "integrate")
        requireGate(
          task.state === "verified" || task.state === "accepted" || task.integration_intent,
          "not_verified",
        );
      const attempt = historicalAttempt ?? this.current(task, args.attempt);
      if (args.command === "submit") {
        requireGate(args.attempt === attempt.attempt_id, "stale_attempt");
        requireGate(args.session === attempt.session_id, "stale_session");
        requireGate(args.fence === attempt.fence, "stale_fence");
        requireGate(args.spec_rev === task.spec_rev, "stale_spec");
        if (attempt.thread_id) {
          requireGate(
            this.runtime && caller && caller.thread === attempt.thread_id,
            "stale_thread",
          );
          await caller.assertActive();
          const live = await this.runtime.readThread(attempt.thread_id);
          requireGate(
            !live.error &&
              live.workspace === attempt.workspace &&
              live.provider === "codex" &&
              live.running &&
              !live.blocked &&
              live.turn === caller.turn,
            "identity_conflict",
          );
          requireGate(!attempt.turn_id || attempt.turn_id === caller.turn, "stale_turn");
        } else requireGate(!caller, "stale_thread");
        requireGate(["claimed", "submitted"].includes(task.state), "invalid_state");
        const commit = sha(args.commit);
        requireGate(
          !task.candidate_commit || task.candidate_commit === commit,
          "candidate_conflict",
        );
        await this.commitExists(taskId, task.repo, commit);
        requireGate(
          await this.ancestor(taskId, task.repo, attempt.base_commit, commit),
          "not_descendant",
        );
        requireGate(
          (await this.git(taskId, attempt.workspace, ["rev-parse", "HEAD"])) === commit,
          "workspace_head_mismatch",
        );
        requireGate(
          !(await this.git(taskId, attempt.workspace, [
            "status",
            "--porcelain=v1",
            "--untracked-files=all",
          ])),
          "dirty_worktree",
        );
        if (caller) {
          await caller.assertActive();
          attempt.turn_id = caller.turn;
        }
        attempt.state = "submitted";
        task.candidate_commit = commit;
        task.state = "submitted";
        this.save(task, "submitted", { attempt, commit });
        return { ok: true, task };
      }
      if (args.command === "verify") {
        this.interruptVerification(task);
        requireGate(task.state === "submitted" && task.candidate_commit, "not_submitted");
        requireGate(!task.integration_intent, "needs_reconciliation");
        const G = sha(await this.integration(task)),
          C = task.candidate_commit;
        await this.commitExists(taskId, task.repo, G);
        const verification_id = randomUUID(),
          workspace = join(this.root, "verification", verification_id);
        const v: A2AVerification = {
          verification_id,
          attempt: { ...attempt },
          spec_rev: task.spec_rev,
          G,
          C,
          M: null,
          oracle: task.oracle,
          workspace,
          state: "running",
          command_intent: { argv: ["python3", "-I", "-B", task.oracle, workspace], cwd: workspace },
        };
        task.verification = v;
        task.state = "verifying";
        this.save(task, "verification_intent", v);
        mkdirSync(join(this.root, "verification"), { recursive: true });
        if (await this.ancestor(taskId, task.repo, G, C)) {
          v.M = C;
          await this.git(taskId, task.repo, ["worktree", "add", "--detach", workspace, C]);
        } else {
          await this.git(taskId, task.repo, ["worktree", "add", "--detach", workspace, G]);
          const env = {
            ...process.env,
            GIT_AUTHOR_NAME: "A2A",
            GIT_AUTHOR_EMAIL: "a2a@localhost",
            GIT_COMMITTER_NAME: "A2A",
            GIT_COMMITTER_EMAIL: "a2a@localhost",
          };
          const merge = await this.execute(
            taskId,
            [
              "git",
              "-C",
              workspace,
              "-c",
              "core.hooksPath=/dev/null",
              "merge",
              "--no-ff",
              "--no-commit",
              "--no-edit",
              C,
            ],
            workspace,
            env,
          );
          if (merge.returncode !== 0) {
            v.state = "merge_failed";
            v.result = merge;
            task.state = "submitted";
            this.save(task, "verification_result", v);
            throw new Refusal("merge_conflict", v);
          }
          const tree = await this.git(taskId, workspace, ["write-tree"]);
          v.M = await this.git(
            taskId,
            workspace,
            ["commit-tree", tree, "-p", G, "-p", C, "-m", `A2A managed integration ${taskId}`],
            [0],
            env,
          );
          await this.git(taskId, workspace, ["reset", "--hard", v.M]);
        }
        this.save(task, "merge_candidate", v);
        try {
          const result = await this.execute(taskId, v.command_intent!.argv, workspace);
          v.result = result;
          v.state = result.returncode === 0 ? "passed" : "failed";
          task.state = result.returncode === 0 ? "verified" : "submitted";
        } catch (error) {
          if (!(error instanceof Refusal)) throw error;
          v.state = "unknown";
          task.state = "paused";
          v.result = {
            argv: v.command_intent!.argv,
            cwd: workspace,
            returncode: null,
            exit: null,
            stdout: null,
            stderr: null,
            outcome: "unknown",
          };
          v.ended = new Date().toISOString();
          this.save(task, "verification_result", { verification: v, failure: error.details });
          throw new Refusal("verification_unknown", v);
        }
        v.ended = new Date().toISOString();
        this.save(task, "verification_result", v);
        requireGate(v.state === "passed", "oracle_failed", v);
        return { ok: true, task, verification: v };
      }
      if (args.command === "integrate") {
        if (task.state === "accepted") return { ok: true, task, replayed: true };
        let intent = task.integration_intent;
        const v = task.verification;
        requireGate((task.state === "verified" || intent) && v?.state === "passed", "not_verified");
        this.checkVerification(task, attempt, v);
        requireGate(v.M, "not_verified");
        const actual = await this.integration(task);
        if (intent) {
          requireGate(
            task.state === "integrating" &&
              intent.state === "pending" &&
              intent.verification_id === v.verification_id &&
              intent.G === v.G &&
              intent.M === v.M &&
              intent.C === v.C &&
              intent.spec_rev === v.spec_rev &&
              intent.oracle === v.oracle &&
              intent.attempt.task_id === taskId &&
              intent.attempt.attempt_id === attempt.attempt_id &&
              intent.attempt.session_id === attempt.session_id &&
              intent.attempt.fence === attempt.fence &&
              intent.attempt.spec_rev === task.spec_rev &&
              (actual === intent.G || actual === intent.M),
            "needs_reconciliation",
            { intent, actual },
          );
          if (actual === intent.M) {
            intent.state = "completed";
            task.state = "accepted";
            attempt.state = "accepted";
            this.save(task, "integrated_reconciled", intent);
            return { ok: true, task, reconciled: true };
          }
        } else {
          if (actual !== v.G) {
            task.state = "submitted";
            task.verification = null;
            this.save(task, "integration_conflict", { expected: v.G, actual });
            throw new Refusal("integration_conflict");
          }
          intent = {
            G: v.G,
            C: v.C,
            M: v.M,
            verification_id: v.verification_id,
            attempt: { ...attempt },
            spec_rev: v.spec_rev,
            oracle: v.oracle,
            intent_id: randomUUID(),
            state: "pending",
            command_intent: {
              argv: ["git", "-C", task.repo, "update-ref", REF, v.M, v.G],
              cwd: task.repo,
            },
          };
          task.integration_intent = intent;
          task.state = "integrating";
          this.save(task, "integration_intent", intent);
        }
        const result = await this.execute(taskId, intent.command_intent!.argv, task.repo);
        const readback = await this.integration(task);
        intent.result = result;
        const completed = result.returncode === 0 && readback === intent.M;
        if (completed) {
          intent.state = "completed";
          task.state = "accepted";
          attempt.state = "accepted";
        }
        this.save(task, completed ? "integrated" : "integration_conflict", { intent, readback });
        requireGate(completed, "needs_reconciliation", { intent, readback });
        return { ok: true, task };
      }
      requireGate(args.command === "reclaim", "invalid_command");
      const ownsTask = task.current_attempt?.attempt_id === attempt.attempt_id;
      if (attempt.reclaimed) {
        if (ownsTask && task.state !== "accepted") this.invalidate(task, "controller reclaim");
        return { ok: true, task };
      }
      requireGate(
        !ownsTask || !task.integration_intent || task.integration_intent.state === "completed",
        "needs_reconciliation",
      );
      requireGate(this.runtime && attempt.thread_id, "no_bound_thread");
      const live = await this.runtime.readThread(attempt.thread_id);
      requireGate(
        live.workspace === attempt.workspace && live.provider === "codex",
        "identity_conflict",
      );
      this.checkThread(attempt, live);
      this.checkErrorReclaim(live);
      requireGate(!live.blocked, "run_blocked", live);
      requireGate(!live.running, "worker_working");
      this.event(taskId, "reclaim_intent", { attempt, live }, attempt.attempt_id);
      if (ownsTask && task.state !== "accepted") this.invalidate(task, "controller reclaim");
      this.checkUserInputObserver();
      await this.runtime.stopThread(attempt.thread_id);
      const stopped = await this.runtime.readThread(attempt.thread_id);
      this.checkThread(attempt, stopped);
      requireGate(stopped.stopped, "stop_unconfirmed");
      this.checkUserInputObserver();
      await this.runtime.archiveThread(attempt.thread_id);
      const archived = await this.runtime.readThread(attempt.thread_id);
      this.checkThread(attempt, archived);
      requireGate(archived.archived && archived.stopped, "reclaim_unconfirmed");
      attempt.reclaimed = true;
      attempt.reclaimed_at = new Date().toISOString();
      this.member(task, attempt.thread_id, "worker", attempt.reclaimed_at);
      this.save(task, "reclaimed", { attempt, archived }, attempt);
      return { ok: true, task };
    } catch (error) {
      const ioCode = (error as NodeJS.ErrnoException).code;
      const code =
        error instanceof Refusal
          ? error.code
          : [
                "ENOENT",
                "EACCES",
                "EEXIST",
                "EISDIR",
                "ENOTDIR",
                "ERR_ENCODING_INVALID_ENCODED_DATA",
              ].includes(ioCode ?? "")
            ? "local_io_failed"
            : "gate_failure";
      const details = error instanceof Refusal ? error.details : String(error);
      // A failed observer must remain queryable even when SQLite cannot append.
      if (taskId && this.userInputObserver?.state !== "failed")
        this.event(taskId, "rejected", { error: code, details, input: raw });
      return { ok: false, error: code, details };
    } finally {
      lock?.close();
    }
  }
}
