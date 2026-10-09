import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "vitest";
import { A2AGates, Refusal, type GateRuntime } from "./core";

it("keeps handoff records immutable and appends one terminal recipient ack", async () => {
  const gates = new A2AGates(mkdtempSync(join(tmpdir(), "t058-inbox-")));
  try {
    const sent: any = await gates.call({
      command: "inbox_send",
      from: "ideation",
      to: "executor",
      kind: "assign",
      refs: ["ticket:T-058"],
      body: "Sentinel α\n第二行保持原样",
    });
    assert.equal(
      sent.entry?.kind,
      "assign",
      "new inbox contract must store the entry even without a live target",
    );
    assert.equal(sent.ok, false, "no runtime cannot claim a delivered wake");
    const listed: any = await gates.call({ command: "inbox_list", role: "executor" });
    assert.equal(listed.entries.length, 1);
    assert.equal(listed.entries[0].entry.body, "Sentinel α\n第二行保持原样");
    const wrong: any = await gates.call({
      command: "inbox_ack",
      role: "ideation",
      id: sent.entry.id,
    });
    assert.equal(wrong.error, "recipient_required");
    const first: any = await gates.call({
      command: "inbox_ack",
      role: "executor",
      id: sent.entry.id,
    });
    assert.equal(first.entry.kind, "ack");
    assert.equal(first.entry.reply_to, sent.entry.id);
    const again: any = await gates.call({
      command: "inbox_ack",
      role: "executor",
      id: sent.entry.id,
    });
    assert.equal(again.entry.id, first.entry.id);
    const terminal: any = await gates.call({
      command: "inbox_ack",
      role: "ideation",
      id: first.entry.id,
    });
    assert.equal(terminal.error, "ack_is_terminal");
    const after: any = await gates.call({ command: "inbox_list", role: "executor" });
    assert.deepEqual(after.entries, []);
  } finally {
    gates.close();
  }
});

// Controlled clock/native boundary: the gate, locks, Git and SQLite are real.
async function handoffFixture() {
  const root = mkdtempSync(join(tmpdir(), "t058-handoff-"));
  const repo = join(root, "repo");
  mkdirSync(repo);
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", repo, ...args], {
      encoding: "utf8",
      env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  git("init");
  git("config", "user.name", "T058 contract");
  git("config", "user.email", "fixture@example.invalid");
  writeFileSync(join(repo, "sentinel.txt"), "independent input\n");
  git("add", "sentinel.txt");
  git("commit", "-m", "fixture");
  const instructions = join(root, "instructions.txt"),
    oracle = join(root, "oracle.py");
  writeFileSync(instructions, "No model in this clock test.");
  writeFileSync(oracle, "raise SystemExit(0)\n");
  let now = Date.parse("2026-10-09T10:00:00Z");
  const live = new Map<string, any>();
  const effects: { kind: string; thread: string; entry?: any }[] = [];
  let wakeFailure: Error | undefined;
  let wakeCalls = 0;
  const runtime: GateRuntime = {
    ensureProject: async () => {},
    createThread: async () => {},
    startThread: async () => {},
    createAttachedThread: async (task, attachment) => {
      live.set(attachment.thread_id, {
        workspace: task.repo,
        provider: "codex",
        turn: "controlled-turn",
        running: true,
        stopped: false,
        archived: false,
      });
    },
    readThread: async (thread) => live.get(thread),
    wakeThread: async (thread, entry) => {
      wakeCalls++;
      if (wakeFailure) throw wakeFailure;
      effects.push({ kind: "wake", thread, entry });
      return { message: "controlled-message:" + entry.id };
    },
    interruptThread: async (thread) => {
      effects.push({ kind: "interrupt", thread });
    },
    stopThread: async (thread) => {
      effects.push({ kind: "stop", thread });
    },
    archiveThread: async (thread) => {
      effects.push({ kind: "archive", thread });
    },
    sendUserAnswer: async (thread) => {
      if (live.get(thread).archived) throw new Refusal("session_ended");
      effects.push({ kind: "answer", thread });
    },
  };
  const gates = new A2AGates(root, runtime, () => now);
  assert.equal(
    (
      await gates.call({
        command: "create",
        task: "handoff",
        project: "control",
        repo,
        base: git("rev-parse", "HEAD"),
        oracle,
        instructions,
      })
    ).ok,
    true,
  );
  async function attach(role: string, preset?: string) {
    const result = await gates.call({
      command: "attach",
      task: "handoff",
      role,
      ...(preset ? { preset } : {}),
      modelSelection: { provider: "codex", model: "gpt-6.1-sol" },
      runtimeMode: "full-access",
      instructions,
    });
    assert.equal(result.ok, true);
    return result.attachment!.thread_id;
  }
  const executor = await attach("controller", "executor"),
    ideation = await attach("controller", "ideation"),
    worker = await attach("worker");
  return {
    root,
    gates,
    effects,
    live,
    executor,
    ideation,
    worker,
    attach,
    setTime: (value: number) => {
      now = value;
    },
    time: () => now,
    wakeCalls: () => wakeCalls,
    failWake: (unknown = false) => {
      wakeFailure = unknown
        ? new Error("external outcome uncertain")
        : new Refusal("controlled_delivery_failure");
    },
  };
}

it("preserves sentinels, recipient identity, immutable rows and duplicate ack across restart", async () => {
  const f = await handoffFixture();
  try {
    const sent = await f.gates.call({
      command: "inbox_send",
      from: "ideation",
      to: "executor",
      kind: "assign",
      body: "同一正文的变体 Ω\n尾行",
      refs: ["ticket:T-058", "file:spec.md#L9"],
    });
    assert.equal(sent.ok, true);
    assert.equal(sent.entry!.body, "同一正文的变体 Ω\n尾行");
    assert.equal(f.effects[0]!.thread, f.executor);
    const first = await f.gates.call({
      command: "inbox_ack",
      role: "executor",
      id: sent.entry!.id,
    });
    assert.equal(first.ok, true);
    assert.equal(first.entry!.to, "ideation");
    const originalRows = new DatabaseSync(join(f.root, "state.sqlite3"));
    try {
      assert.throws(() => originalRows.exec("UPDATE inbox_records SET data='{}'"), /append only/);
      assert.throws(() => originalRows.exec("DELETE FROM inbox_records"), /append only/);
      assert.throws(
        () => originalRows.exec("UPDATE inbox_deliveries SET data='{}'"),
        /append only/,
      );
      assert.throws(() => originalRows.exec("DELETE FROM inbox_deliveries"), /append only/);
    } finally {
      originalRows.close();
    }
    assert.equal(
      (await f.gates.call({ command: "inbox_edit", id: sent.entry!.id, body: "overwrite" })).ok,
      false,
    );
    assert.equal(f.effects.length, 2);
    f.gates.close();
    f.gates = new A2AGates(f.root);
    const repeated = await f.gates.call({
      command: "inbox_ack",
      role: "executor",
      id: sent.entry!.id,
    });
    assert.equal(repeated.entry!.id, first.entry!.id);
    assert.equal(f.effects.length, 2);
    assert.equal(
      (await f.gates.call({ command: "inbox_list", role: "executor" })).entries!.length,
      0,
    );
  } finally {
    f.gates.close();
  }
});

it("retains delivery failures and rejects ambiguous role sessions", async () => {
  const f = await handoffFixture();
  try {
    await f.attach("controller", "executor");
    const ambiguous = await f.gates.call({
      command: "inbox_send",
      from: "ideation",
      to: "executor",
      kind: "revise",
      body: "ready_rev 2",
      refs: ["ticket:T-058"],
    });
    assert.equal(ambiguous.ok, false);
    assert.equal(ambiguous.delivery!.reason, "ambiguous_role_session");
    assert.equal(f.effects.length, 0);
    f.failWake();
    const failed = await f.gates.call({
      command: "inbox_send",
      from: "executor",
      to: "ideation",
      kind: "report",
      body: "INCOMPLETE delivery sentinel",
    });
    assert.equal(failed.ok, false);
    assert.equal(failed.delivery!.reason, "controlled_delivery_failure");
    const listed = await f.gates.call({ command: "inbox_list", role: "ideation" });
    assert.equal(listed.entries![0]!.entry.id, failed.entry!.id);
    assert.equal(listed.entries![0]!.entry.body, "INCOMPLETE delivery sentinel");
    assert.equal(f.effects.length, 0);
  } finally {
    f.gates.close();
  }
});

it("requires an overdue unacknowledged stop for its exact owned target and only interrupts", async () => {
  const f = await handoffFixture();
  try {
    const missing = await f.gates.call({ command: "stop", thread: f.worker, stop_id: "missing" });
    assert.equal(missing.error, "unknown_inbox_entry");
    const sent = await f.gates.call({
      command: "inbox_send",
      from: "ideation",
      to: "executor",
      kind: "stop",
      body: "URGENT 停止 worker",
      refs: ["thread:" + f.worker],
    });
    const initialTime = f.time();
    for (const elapsed of [0, 119999, 120000]) {
      f.setTime(initialTime + elapsed);
      assert.equal(
        (await f.gates.call({ command: "stop", thread: f.worker, stop_id: sent.entry!.id })).error,
        "stop_too_early",
      );
    }
    f.setTime(initialTime + 120001);
    assert.equal(
      (await f.gates.call({ command: "stop", thread: f.executor, stop_id: sent.entry!.id })).error,
      "worker_target_required",
    );
    const reviewer = await f.attach("reviewer");
    assert.equal(
      (await f.gates.call({ command: "stop", thread: reviewer, stop_id: sent.entry!.id })).error,
      "stop_target_mismatch",
    );
    const before = (await f.gates.call({ command: "status", task: "handoff" })).task;
    const allowed = await f.gates.call({
      command: "stop",
      thread: f.worker,
      stop_id: sent.entry!.id,
    });
    assert.equal(allowed.ok, true);
    assert.equal(allowed.interruptRequested, true);
    assert.deepEqual((await f.gates.call({ command: "status", task: "handoff" })).task, before);
    assert.deepEqual(
      f.effects.filter((e) => e.kind !== "wake"),
      [{ kind: "interrupt", thread: f.worker }],
    );
    await f.gates.call({ command: "inbox_ack", role: "executor", id: sent.entry!.id });
    assert.equal(
      (await f.gates.call({ command: "stop", thread: f.worker, stop_id: sent.entry!.id })).error,
      "stop_already_acknowledged",
    );
  } finally {
    f.gates.close();
  }
});

it("keeps blocking closure user-only and exposes the existing ended-session forward to executor", async () => {
  const f = await handoffFixture();
  try {
    const raised = await f.gates.raiseIssue(
      { title: "独立问题哨兵", body: "正文", blocking: true, refs: [] },
      { thread: f.worker, turn: "controlled-turn", assertActive: async () => {} },
    );
    const bad = await f.gates.call({
      command: "inbox_send",
      from: "executor",
      to: "triage",
      kind: "disposition",
      reply_to: raised.id,
      action: "close",
      reason: "理由",
      basis: "依据",
      body: "非用户关闭",
    });
    assert.equal(bad.error, "blocking_requires_user");
    f.live.get(f.worker).archived = true;
    const answer = await f.gates.call({
      command: "answer_issue",
      task: "handoff",
      issue: raised.id,
      answer: "原样答复",
    });
    assert.equal(answer.ok, true);
    const listed = await f.gates.call({ command: "inbox_list", role: "executor" });
    const forwarded = listed.entries!.find(
      (e) => e.entry.kind === "disposition" && e.entry.reason === "session-ended",
    );
    assert.equal(forwarded!.entry.to, "executor");
    const ack = await f.gates.call({
      command: "inbox_ack",
      role: "executor",
      id: forwarded!.entry.id,
    });
    assert.equal(ack.entry!.reply_to, forwarded!.entry.id);
    const user = await f.gates.call({
      command: "inbox_send",
      from: "user",
      to: "triage",
      kind: "disposition",
      reply_to: raised.id,
      action: "close",
      reason: "用户决定",
      basis: "输入 9",
      body: "用户明确关闭",
    });
    assert.equal(user.ok, true);
    assert.equal(user.entry!.body, "用户明确关闭");
  } finally {
    f.gates.close();
  }
});

it("derives the user inbox from issue dispositions and preserves unknown wakes without a retry", async () => {
  const f = await handoffFixture();
  try {
    const issue = await f.gates.call({
      command: "inbox_send",
      from: "worker:" + f.worker,
      to: "triage",
      kind: "issue",
      title: "blocking sentinel",
      blocking: true,
      body: "请用户判断",
    });
    assert.equal(
      (await f.gates.call({ command: "inbox_list", role: "user" })).entries![0]!.entry.id,
      issue.entry!.id,
    );
    assert.equal(
      (
        await f.gates.call({
          command: "inbox_send",
          from: "system",
          to: "triage",
          kind: "disposition",
          reply_to: issue.entry!.id,
          action: "close",
          reason: "不能越权",
          basis: "外部输入",
          body: "拒绝",
        })
      ).error,
      "blocking_requires_user",
    );
    const closed = await f.gates.call({
      command: "inbox_send",
      from: "user",
      to: "triage",
      kind: "disposition",
      reply_to: issue.entry!.id,
      action: "close",
      reason: "用户关闭",
      basis: "用户原话",
      body: "原文保留",
    });
    assert.equal(closed.entry!.reply_to, issue.entry!.id);
    assert.equal((await f.gates.call({ command: "inbox_list", role: "user" })).entries!.length, 0);
    f.failWake(true);
    const uncertain = await f.gates.call({
      command: "inbox_send",
      from: "executor",
      to: "ideation",
      kind: "needs-decision",
      body: "未知外部副作用 δ",
    });
    assert.equal(uncertain.ok, false);
    assert.equal(uncertain.delivery!.state, "unknown");
    assert.equal(f.wakeCalls(), 1);
    for (let i = 0; i < 2; i++)
      assert.equal(
        (await f.gates.call({ command: "inbox_list", role: "ideation" })).entries!.find(
          (entry) => entry.entry.id === uncertain.entry!.id,
        )!.entry.body,
        "未知外部副作用 δ",
      );
    assert.equal(f.wakeCalls(), 1);
  } finally {
    f.gates.close();
  }
});

it("rejects every kind with an illegal sender or recipient before appending", async () => {
  const root = mkdtempSync(join(tmpdir(), "t058-direction-"));
  const gates = new A2AGates(root);
  const sql = new DatabaseSync(join(root, "state.sqlite3"));
  try {
    const issue = await gates.call({
      command: "inbox_send",
      from: "worker:w1",
      to: "triage",
      kind: "issue",
      title: "direction fixture",
      body: "issue",
    });
    const assign = await gates.call({
      command: "inbox_send",
      from: "ideation",
      to: "executor",
      kind: "assign",
      body: "assign",
    });
    const cases = [
      { kind: "assign", from: "executor", to: "executor" },
      { kind: "revise", from: "executor", to: "executor" },
      { kind: "cancel", from: "ideation", to: "ideation" },
      { kind: "report", from: "ideation", to: "ideation" },
      { kind: "needs-decision", from: "executor", to: "executor" },
      { kind: "stop", from: "executor", to: "executor" },
      { kind: "issue", from: "ideation", to: "triage", title: "invalid issue sender" },
      { kind: "answer", from: "executor", to: "executor" },
      {
        kind: "disposition",
        from: "worker:w1",
        to: "triage",
        reply_to: issue.entry!.id,
        action: "needs-user",
      },
      { kind: "ack", from: "ideation", to: "ideation", reply_to: assign.entry!.id },
    ];
    for (const input of cases) {
      const before = sql.prepare("SELECT id,data FROM inbox_records ORDER BY rowid").all();
      const response = await gates.call({
        command: "inbox_send",
        body: "illegal direction sentinel",
        refs: [],
        ...input,
      });
      assert.equal(response.ok, false, input.kind);
      assert.equal(response.entry, undefined, input.kind + " must reject before append");
      assert.deepEqual(
        sql.prepare("SELECT id,data FROM inbox_records ORDER BY rowid").all(),
        before,
      );
    }
  } finally {
    sql.close();
    gates.close();
  }
});
