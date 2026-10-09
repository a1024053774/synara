import { randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { spawnProcessSync } from "@synara/shared/processRuntime";
import { expect, test } from "vitest";
import { A2AGates, Refusal, type GateRuntime } from "./core";

// Oracle: T-057 ready_rev 2 / controller-split-user-input spec §4, handwritten.
// Real Git/SQLite/operation locks; native lifecycle is a controlled boundary.
// Failure categories are recorded in PLAN-resume.md before implementation.
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "a2a-issue-contract-"));
  console.log(JSON.stringify({ fixture_root: root }));
  const repo = join(root, "repo");
  mkdirSync(repo);
  const git = (...argv: string[]) => {
    const result = spawnProcessSync("git", ["-C", repo, ...argv], {
      encoding: "utf8",
      env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
    });
    expect(result.status, result.stderr).toBe(0);
    return result.stdout.trim();
  };
  git("init");
  git("config", "user.name", "Issue contract fixture");
  git("config", "user.email", "fixture@example.invalid");
  git("config", "commit.gpgsign", "false");
  writeFileSync(join(repo, "sentinel.txt"), "An external sentinel\n");
  git("add", "sentinel.txt");
  git("commit", "-m", "External baseline");
  writeFileSync(join(root, "oracle.py"), "raise SystemExit(0)\n");
  writeFileSync(join(root, "instructions.txt"), "Controlled boundary, no model invocation.\n");
  const threads = new Map<
    string,
    {
      workspace: string;
      provider: string;
      turn: string | null;
      running: boolean;
      stopped: boolean;
      archived: boolean;
    }
  >();
  const messages: { thread: string; messageId: string; message: string }[] = [];
  let now = Date.now();
  let sendError: Error | undefined;
  let hold: Promise<void> | undefined;
  let sending: (() => void) | undefined;
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
    startThread: async (_task, attempt) => {
      Object.assign(threads.get(attempt.thread_id)!, { running: true, turn: "turn-sentinel" });
    },
    createAttachedThread: async (_task, attachment) => {
      threads.set(attachment.thread_id, {
        workspace: repo,
        provider: "codex",
        turn: "controller-turn",
        running: true,
        stopped: false,
        archived: false,
      });
    },
    readThread: async (thread) => ({ ...threads.get(thread)! }),
    stopThread: async (thread) => {
      Object.assign(threads.get(thread)!, { running: false, stopped: true });
    },
    archiveThread: async (thread) => {
      threads.get(thread)!.archived = true;
    },
    sendUserAnswer: async (thread, messageId, message) => {
      sending?.();
      if (hold) await hold;
      if (sendError) throw sendError;
      if (threads.get(thread)!.archived) throw new Refusal("session_ended");
      messages.push({ thread, messageId, message });
    },
  };
  const gates = new A2AGates(join(root, "state"), runtime, () => now);
  const create = await gates.call({
    command: "create",
    task: "issues",
    project: "sentinel-project",
    repo,
    base: git("rev-parse", "HEAD"),
    oracle: join(root, "oracle.py"),
    instructions: join(root, "instructions.txt"),
  });
  expect(create.ok, JSON.stringify(create)).toBe(true);
  const dispatched = await gates.call({
    command: "dispatch",
    task: "issues",
    runtimeMode: "approval-required",
  });
  expect(dispatched.ok, JSON.stringify(dispatched)).toBe(true);
  const worker = dispatched.attempt!;
  const raised = async (title = "标题哨兵", body = "", blocking = false) => {
    const result = await gates.raiseIssue(
      { title, body, blocking, refs: ["file:sentinel.txt#L1"] },
      { thread: worker.thread_id, turn: "turn-sentinel", assertActive: async () => {} },
    );
    expect(result.ok).toBe(true);
    return result.id;
  };
  const call = (command: string, args: Record<string, unknown> = {}) =>
    gates.call({ command, task: "issues", ...args });
  return {
    root,
    gates,
    threads,
    messages,
    worker,
    raised,
    call,
    time: (value: number) => {
      now = value;
    },
    now: () => now,
    failSend: (error?: Error) => {
      sendError = error;
    },
    holdSend: (value: Promise<void>, callback: () => void) => {
      hold = value;
      sending = callback;
    },
  };
}

test("dispositions are append-only and expire from the injected clock", async () => {
  const f = await fixture();
  try {
    const issue = await f.raised();
    const original = (await f.call("issues")).issues![0]!.issue;
    expect((await f.call("issues")).issues![0]!.state).toBe("待判断");
    f.time(f.now() + 900_000);
    expect((await f.call("issues")).issues![0]!.state).toBe("等你决定");
    expect((await f.call("disposition", { issue, action: "close", reason: "重复" })).ok).toBe(
      false,
    );
    const close = await f.call("disposition", {
      issue,
      action: "close",
      reason: "重复",
      basis: "file:sentinel.txt#L1",
    });
    expect(close.ok, JSON.stringify(close)).toBe(true);
    expect(close.issues![0]!.state).toBe("已关闭");
    expect(close.issues![0]!.disposition).toMatchObject({
      from: "user",
      reason: "重复",
      basis: "file:sentinel.txt#L1",
    });
    expect((await f.call("answer_issue", { issue, answer: "不应写入" })).ok).toBe(false);
    expect((await f.call("disposition", { issue, action: "reopen" })).issues![0]!.state).toBe(
      "等你决定",
    );
    expect((await f.call("disposition", { issue, action: "forward" })).issues![0]!.state).toBe(
      "已转交",
    );
    f.time(f.now() + 899_999);
    expect((await f.call("issues")).issues![0]!.state).toBe("已转交");
    f.time(f.now() + 1);
    expect((await f.call("issues")).issues![0]!.state).toBe("等你决定");
    expect((await f.call("disposition", { issue, action: "snooze" })).issues![0]!.state).toBe(
      "稍后",
    );
    const snoozedAt = f.now();
    f.time(snoozedAt - 60_000);
    expect((await f.call("issues")).issues![0]!.state).toBe("稍后");
    f.time(snoozedAt + 3_599_999);
    expect((await f.call("issues")).issues![0]!.state).toBe("稍后");
    f.time(snoozedAt + 3_600_000);
    expect((await f.call("issues")).issues![0]!.state).toBe("等你决定");
    expect((await f.call("disposition", { issue, action: "needs-user" })).issues![0]!.state).toBe(
      "等你决定",
    );
    expect((await f.call("disposition", { issue, action: "dismiss" })).issues![0]!.state).toBe(
      "已关闭",
    );
    const final = await f.call("issues");
    expect(final.issues![0]!.issue).toEqual(original);
    expect(final.records!.filter((r) => r.kind === "disposition").map((r) => r.action)).toEqual([
      "close",
      "reopen",
      "forward",
      "snooze",
      "needs-user",
      "dismiss",
    ]);
    const db = new DatabaseSync(join(f.root, "state/state.sqlite3"));
    expect(() => db.exec("UPDATE issue_records SET data='{}'")).toThrow("append only");
    expect(() => db.exec("DELETE FROM issue_records")).toThrow("append only");
    db.close();
  } finally {
    f.gates.close();
  }
});

test("controller credentials cannot close blocking issues, dismiss, or answer", async () => {
  const f = await fixture();
  try {
    const issue = await f.raised("需要用户", "权限原样，不做内容判断", true);
    const attached = await f.call("attach", {
      role: "controller",
      runtimeMode: "approval-required",
      instructions: join(f.root, "instructions.txt"),
      modelSelection: { provider: "codex", model: "gpt-6.1-sol" },
    });
    expect(attached.ok, JSON.stringify(attached)).toBe(true);
    const caller = {
      thread: attached.attachment!.thread_id,
      turn: "controller-turn",
      assertActive: async () => {},
    };
    const act = (action: string) =>
      f.gates.call(
        {
          command: "disposition",
          task: "issues",
          issue,
          action,
          reason: "原因",
          basis: "外部依据",
          actor: "user",
        },
        caller,
      );
    expect((await act("close")).error).toBe("blocking_requires_user");
    expect((await act("dismiss")).error).toBe("user_required");
    expect((await act("needs-user")).ok).toBe(true);
    expect(
      (
        await f.gates.call(
          { command: "answer_issue", task: "issues", issue, answer: "伪答复" },
          caller,
        )
      ).ok,
    ).toBe(false);
    expect(
      (
        await f.gates.call(
          {
            command: "disposition",
            task: "issues",
            issue,
            action: "close",
            reason: "伪角色",
            basis: "伪依据",
          },
          { thread: f.worker.thread_id, turn: "turn-sentinel", assertActive: async () => {} },
        )
      ).ok,
    ).toBe(false);
    expect((await f.call("disposition", { issue, action: "dismiss" })).ok).toBe(true);
  } finally {
    f.gates.close();
  }
});

test("bundle keeps independent question numbers, exact Unicode text and one native message", async () => {
  const f = await fixture();
  try {
    const one = await f.raised("oracle 漏了空页", "分页夹具没有覆盖最后一页为空的情况。");
    await f.raised("未答的不参加", "不应被送出");
    const three = await f.raised("README 的构建命令已过期");
    const before = (await f.call("status")).task;
    const result = await f.call("answer_issues", {
      answers: [
        { issue: one, answer: "补上，并在 RESULTS 里写明。  \n" },
        { issue: three, answer: "不用管，T-050 会重写。" },
      ],
      mode: "bundle",
    });
    expect(result.ok, JSON.stringify(result)).toBe(true);
    expect(f.messages.map((m) => m.message)).toEqual([
      "问题 1：oracle 漏了空页\n分页夹具没有覆盖最后一页为空的情况。\n用户答复：补上，并在 RESULTS 里写明。\n\n问题 3：README 的构建命令已过期\n用户答复：不用管，T-050 会重写。",
    ]);
    expect(result.user_inputs!.map((r) => r.reply_to)).toEqual([one, three]);
    expect(
      result.user_inputs!.every(
        (r) => r.form === "answer" && r.target.message === f.messages[0]!.messageId,
      ),
    ).toBe(true);
    expect(new Set(result.user_inputs!.map((r) => r.bundle_id)).size).toBe(1);
    expect(result.issues!.map((v) => v.state)).toEqual(["已送达", "待判断", "已送达"]);
    expect((await f.call("status")).task).toEqual(before);
    expect(
      f.gates.recordHumanInput({
        thread_id: f.worker.thread_id,
        message_id: f.messages[0]!.messageId,
        event_id: randomUUID(),
        source_sequence: 100,
        turn_id: null,
        created_at: new Date().toISOString(),
        text: f.messages[0]!.message,
        dispatch_origin: "user",
      }),
    ).toBe(false);
    expect((await f.call("issues")).user_inputs).toEqual(result.user_inputs);
    const unicode = await f.raised("分隔哨兵", "😀".repeat(601));
    const sent = await f.call("answer_issue", {
      issue: unicode,
      answer: "\n问题 99：保留\n用户答复：原样  \n",
    });
    expect(sent.ok).toBe(true);
    expect(f.messages[1]!.message).toBe(
      "问题 4：分隔哨兵\n" + "😀".repeat(599) + "…\n用户答复：\n问题 99：保留\n用户答复：原样",
    );
    const noBody = await f.raised("空正文");
    const edge = await f.raised("恰好六百", "字".repeat(600));
    expect(
      (
        await f.call("answer_issues", {
          answers: [
            { issue: noBody, answer: "一" },
            { issue: edge, answer: "二" },
          ],
          mode: "individual",
        })
      ).ok,
    ).toBe(true);
    expect(f.messages.slice(2).map((m) => m.message)).toEqual([
      "问题 5：空正文\n用户答复：一",
      "问题 6：恰好六百\n" + "字".repeat(600) + "\n用户答复：二",
    ]);
    expect(
      new Set((await f.call("issues")).user_inputs!.slice(-2).map((r) => r.target.message)).size,
    ).toBe(2);
  } finally {
    f.gates.close();
  }
});

test("duplicates and close/answer overlap preserve one recorded answer", async () => {
  const f = await fixture();
  try {
    const issue = await f.raised();
    const duplicate = await f.call("answer_issues", {
      answers: [
        { issue, answer: "一" },
        { issue, answer: "二" },
      ],
      mode: "bundle",
    });
    expect(duplicate.ok).toBe(false);
    expect((await f.call("issues")).user_inputs).toHaveLength(0);
    let release!: () => void;
    let started!: () => void;
    const seen = new Promise<void>((resolve) => {
      started = resolve;
    });
    f.holdSend(
      new Promise<void>((resolve) => {
        release = resolve;
      }),
      started,
    );
    const first = f.call("answer_issue", { issue, answer: "唯一答复" });
    await seen;
    const second = await f.call("answer_issue", { issue, answer: "重复窗口" });
    expect(second.error).toBe("operation_busy");
    expect(
      (await f.call("disposition", { issue, action: "close", reason: "交叠", basis: "哨兵" }))
        .error,
    ).toBe("operation_busy");
    release();
    expect((await first).ok).toBe(true);
    expect((await f.call("answer_issue", { issue, answer: "再次重复" })).error).toBe(
      "issue_answered",
    );
    expect((await f.call("issues")).user_inputs).toHaveLength(1);
    expect(f.messages).toHaveLength(1);
  } finally {
    f.gates.close();
  }
});

test("close notices wait for the next successful message and are sent once", async () => {
  const f = await fixture();
  try {
    const closed = await f.raised("重复问题");
    const active = await f.raised("另一题");
    expect(
      (
        await f.call("disposition", {
          issue: closed,
          action: "close",
          reason: "已有 ticket",
          basis: "ticket:T-099",
        })
      ).ok,
    ).toBe(true);
    expect(f.messages).toHaveLength(0);
    expect((await f.call("answer_issue", { issue: active, answer: "继续" })).ok).toBe(true);
    expect(f.messages[0]!.message).toBe(
      "问题 2：另一题\n用户答复：继续\n\n（另：你上报的问题 1 已被关闭，理由：已有 ticket。如不同意，请重新上报并补充证据。）",
    );
    const next = await f.raised("后续哨兵");
    expect((await f.call("answer_issue", { issue: next, answer: "收到了" })).ok).toBe(true);
    expect(f.messages[1]!.message).toBe("问题 3：后续哨兵\n用户答复：收到了");
    const ended = await f.raised("结束后答复");
    f.threads.get(f.worker.thread_id)!.archived = true;
    const result = await f.call("answer_issue", { issue: ended, answer: "保留不送" });
    expect(result.ok).toBe(true);
    expect(result.issues!.at(-1)!.state).toBe("已转交");
    expect(result.records!.at(-1)).toMatchObject({
      action: "forward",
      to: "executor",
      reason: "session-ended",
    });
    expect(f.messages).toHaveLength(2);
    f.threads.get(f.worker.thread_id)!.archived = false;
    const unknown = await f.raised("未知错误");
    f.failSend(new Error("sentinel-unknown-delivery"));
    expect((await f.call("answer_issue", { issue: unknown, answer: "不可假报" })).ok).toBe(false);
    expect((await f.call("issues")).issues!.at(-1)!.state).toBe("已答复");
  } finally {
    f.gates.close();
  }
});

test("legacy message uniqueness migrates without changing input bytes or append-only guards", () => {
  const root = mkdtempSync(join(tmpdir(), "a2a-legacy-input-"));
  const path = join(root, "state.sqlite3");
  const legacy = JSON.stringify({
    id: "legacy-sentinel",
    text: '引号 " 与 emoji 😀',
    source: "independent legacy fixture",
  });
  const before = new DatabaseSync(path);
  before.exec(
    "CREATE TABLE user_inputs (id TEXT PRIMARY KEY, task TEXT NOT NULL, message TEXT NOT NULL UNIQUE, data TEXT NOT NULL)",
  );
  before
    .prepare("INSERT INTO user_inputs VALUES (?,?,?,?)")
    .run("legacy-sentinel", "task-sentinel", "message-sentinel", legacy);
  before.close();
  const gates = new A2AGates(root);
  gates.close();
  const after = new DatabaseSync(path);
  try {
    expect(
      after.prepare("SELECT data FROM user_inputs WHERE id='legacy-sentinel'").get()!.data,
    ).toBe(legacy);
    after
      .prepare("INSERT INTO user_inputs VALUES (?,?,?,?)")
      .run("second-sentinel", "task-sentinel", "message-sentinel", "second immutable record");
    expect(
      after
        .prepare("SELECT count(*) AS count FROM user_inputs WHERE message='message-sentinel'")
        .get()!.count,
    ).toBe(2);
    expect(() => after.exec("UPDATE user_inputs SET data='rewritten'")).toThrow("append only");
    expect(() => after.exec("DELETE FROM user_inputs")).toThrow("append only");
  } finally {
    after.close();
  }
});

test("bundles partition historical sessions and individual close notices occur once", async () => {
  const f = await fixture();
  try {
    const historical = await f.raised("历史会话哨兵");
    const closed = await f.raised("已关闭哨兵");
    const one = await f.raised("第一条");
    const two = await f.raised("第二条");
    expect(
      (
        await f.call("disposition", {
          issue: closed,
          action: "close",
          reason: "重复",
          basis: "ticket:T-099",
        })
      ).ok,
    ).toBe(true);
    expect(
      (
        await f.call("answer_issues", {
          answers: [
            { issue: one, answer: "一" },
            { issue: two, answer: "二" },
          ],
          mode: "individual",
        })
      ).ok,
    ).toBe(true);
    expect(f.messages.map((m) => m.message)).toEqual([
      "问题 3：第一条\n用户答复：一\n\n（另：你上报的问题 2 已被关闭，理由：重复。如不同意，请重新上报并补充证据。）",
      "问题 4：第二条\n用户答复：二",
    ]);
    expect((await f.call("revoke", { reason: "session replacement fixture" })).ok).toBe(true);
    const next = await f.call("dispatch", { runtimeMode: "approval-required" });
    expect(next.ok).toBe(true);
    const current = await f.gates.raiseIssue(
      { title: "新会话哨兵", body: "", blocking: true, refs: [] },
      { thread: next.attempt!.thread_id, turn: "turn-sentinel", assertActive: async () => {} },
    );
    const bundled = await f.call("answer_issues", {
      answers: [
        { issue: historical, answer: "保留" },
        { issue: current.id, answer: "当前" },
      ],
      mode: "bundle",
    });
    expect(bundled.ok).toBe(true);
    const inputs = bundled.user_inputs!.slice(-2);
    expect(new Set(inputs.map((input) => input.bundle_id)).size).toBe(2);
    expect(new Set(inputs.map((input) => input.target.message)).size).toBe(2);
    expect(f.messages.at(-1)).toMatchObject({
      thread: next.attempt!.thread_id,
      message: "问题 1：新会话哨兵\n用户答复：当前",
    });
    expect(bundled.issues!.find((view) => view.issue.id === historical)!.state).toBe("已转交");
  } finally {
    f.gates.close();
  }
});

test("reopen restores the reply cycle even when it is snoozed afterwards", async () => {
  const f = await fixture();
  try {
    const issue = await f.raised("重开周期哨兵");
    expect((await f.call("answer_issue", { issue, answer: "第一次" })).ok).toBe(true);
    expect(
      (
        await f.call("disposition", {
          issue,
          action: "close",
          reason: "暂时解决",
          basis: "用户核对",
        })
      ).ok,
    ).toBe(true);
    expect((await f.call("disposition", { issue, action: "reopen" })).ok).toBe(true);
    expect((await f.call("disposition", { issue, action: "snooze" })).ok).toBe(true);
    const second = await f.call("answer_issue", { issue, answer: "重开后的答复" });
    expect(second.ok, JSON.stringify(second)).toBe(true);
    expect(second.user_inputs!.map((input) => input.text)).toEqual(["第一次", "重开后的答复"]);
    expect(second.issues![0]!.answer!.body).toBe("重开后的答复");
  } finally {
    f.gates.close();
  }
});

test("needs-user permits the requested follow-up answer without discarding the previous one", async () => {
  const f = await fixture();
  try {
    const issue = await f.raised("再次决定哨兵");
    expect((await f.call("answer_issue", { issue, answer: "原决定" })).ok).toBe(true);
    const requested = await f.call("disposition", {
      issue,
      action: "needs-user",
      reason: "需要再次决定",
    });
    expect(requested.issues![0]!.state).toBe("等你决定");
    expect((await f.call("answer_issue", { issue, answer: "新的决定" })).ok).toBe(true);
    expect((await f.call("issues")).user_inputs!.map((input) => input.text)).toEqual([
      "原决定",
      "新的决定",
    ]);
  } finally {
    f.gates.close();
  }
});
