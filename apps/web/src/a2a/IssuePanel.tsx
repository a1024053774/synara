import type { A2AGateResult, A2AIssueAction, A2AIssueView } from "@synara/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Textarea } from "../components/ui/textarea";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectPopup,
  SelectItem,
} from "../components/ui/select";
import { requestA2A } from "./api";
import { useIssueDrafts } from "./issueDrafts";
import { taskIssuesQueryOptions } from "./useIssues";

function canReply(view: A2AIssueView) {
  return (
    view.state !== "已关闭" && view.state !== "已送达" && view.state !== "已答复" && !view.answer
  );
}

function IssueDisposition({ view }: { view: A2AIssueView }) {
  const [editing, setEditing] = useState(false);
  const [reason, setReason] = useState("");
  const [basis, setBasis] = useState("");
  const client = useQueryClient();
  const mutation = useMutation({
    mutationFn: async (action: A2AIssueAction) => {
      const result = await requestA2A<A2AGateResult>("/api/a2a", {
        command: "disposition",
        task: view.issue.task_id,
        issue: view.issue.id,
        action,
        ...(action === "close" ? { reason, basis } : {}),
      });
      if (!result.ok) throw new Error(result.error ?? "处置未保存");
      return result;
    },
    onSuccess: () => {
      setEditing(false);
      void client.invalidateQueries({ queryKey: ["a2a-issues", view.issue.task_id] });
    },
  });
  return (
    <div className="space-y-2">
      {view.state === "已关闭" ? (
        <>
          <p className="whitespace-pre-wrap break-words text-ui-sm">
            关闭理由：{view.disposition?.reason ?? view.disposition?.body}
          </p>
          {view.disposition?.basis && (
            <p className="whitespace-pre-wrap break-words text-ui-xs text-muted-foreground">
              依据：{view.disposition.basis}
            </p>
          )}
          <Button
            size="xs"
            variant="outline"
            disabled={mutation.isPending}
            onClick={() => mutation.mutate("reopen")}
          >
            重开
          </Button>
        </>
      ) : (
        <div className="flex flex-wrap gap-1">
          <Button
            size="xs"
            variant="ghost"
            disabled={mutation.isPending}
            onClick={() => mutation.mutate("snooze")}
          >
            稍后（1 小时）
          </Button>
          <Button
            size="xs"
            variant="ghost"
            disabled={mutation.isPending}
            onClick={() => mutation.mutate("dismiss")}
          >
            不处理
          </Button>
          <Button
            size="xs"
            variant="ghost"
            disabled={mutation.isPending}
            onClick={() => setEditing(!editing)}
          >
            关闭
          </Button>
        </div>
      )}
      {editing && (
        <form
          className="space-y-2"
          onSubmit={(event) => {
            event.preventDefault();
            mutation.mutate("close");
          }}
        >
          <Input
            aria-label={`问题 ${view.issue.number} 的关闭理由`}
            placeholder="关闭理由"
            required
            value={reason}
            onChange={(event) => setReason(event.target.value)}
          />
          <Input
            aria-label={`问题 ${view.issue.number} 的关闭依据`}
            placeholder="依据（文件、ticket 或事实）"
            required
            value={basis}
            onChange={(event) => setBasis(event.target.value)}
          />
          <div className="flex gap-2">
            <Button
              size="xs"
              type="submit"
              disabled={mutation.isPending || !reason.trim() || !basis.trim()}
            >
              确认关闭
            </Button>
            <Button size="xs" variant="ghost" type="button" onClick={() => setEditing(false)}>
              取消
            </Button>
          </div>
        </form>
      )}
      {mutation.error && (
        <p role="alert" className="text-ui-xs text-destructive">
          {mutation.error.message}
        </p>
      )}
    </div>
  );
}

export function IssuePanel({ task, thread }: { task: string; thread?: string }) {
  const query = useQuery(taskIssuesQueryOptions(task));
  const [filter, setFilter] = useState<"waiting" | "all" | "closed">("waiting");
  const [mode, setMode] = useState<"bundle" | "individual">("bundle");
  const { drafts, error: draftError, load, change, clear } = useIssueDrafts();
  useEffect(load, [load]);
  const client = useQueryClient();
  const send = useMutation({
    mutationFn: async (replies: { issue: string; answer: string }[]) => {
      const result = await requestA2A<A2AGateResult>(
        "/api/a2a",
        replies.length === 1
          ? { command: "answer_issue", task, ...replies[0] }
          : { command: "answer_issues", task, answers: replies, mode },
      );
      if (!result.ok) throw new Error(result.error ?? "答复未送达，请核对问题记录。");
      return result;
    },
    onSuccess: (_result, replies) => clear(replies.map((reply) => reply.issue)),
    onSettled: () => {
      void client.invalidateQueries({ queryKey: ["a2a-issues", task] });
      void client.invalidateQueries({ queryKey: ["a2a-task", task] });
    },
  });
  const issues = (query.data ?? []).filter(
    (view) => thread === undefined || view.issue.thread_id === thread,
  );
  const visible = issues.filter(
    (view) => filter === "all" || view.state === (filter === "closed" ? "已关闭" : "等你决定"),
  );
  const replies = issues
    .filter((view) => canReply(view) && drafts[view.issue.id]?.trim())
    .map((view) => ({ issue: view.issue.id, answer: drafts[view.issue.id]! }));
  if (!query.error && !issues.length) return null;
  return (
    <aside
      aria-label={thread ? "问题上报" : "问题汇总"}
      data-a2a-issues={thread ?? task}
      style={{ maxHeight: "min(60dvh, 36rem)" }}
      className="flex min-h-0 shrink-0 flex-col gap-2 border-b border-border bg-muted/20 px-3 py-3 text-ui"
    >
      <header className="flex shrink-0 flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <h4 className="font-medium">{thread ? "问题上报" : "问题汇总"}</h4>
          <Badge
            variant="warning"
            aria-label={`等你决定 ${issues.filter((view) => view.state === "等你决定").length} 题`}
          >
            {issues.filter((view) => view.state === "等你决定").length}
          </Badge>
        </div>
        <div className="flex gap-1" aria-label="问题视图">
          {(
            [
              ["waiting", "等你决定"],
              ["all", "全部"],
              ["closed", "已关闭"],
            ] as const
          ).map(([value, label]) => (
            <Button
              key={value}
              size="xs"
              variant={filter === value ? "secondary" : "ghost"}
              aria-pressed={filter === value}
              onClick={() => setFilter(value)}
            >
              {label}
            </Button>
          ))}
        </div>
      </header>
      {query.error ? (
        <p role="alert" className="text-ui-xs text-destructive">
          {query.error.message}
        </p>
      ) : (
        <div
          data-a2a-issue-list
          className="min-h-0 flex-1 overflow-y-auto overscroll-contain pb-3 pr-1"
        >
          {!visible.length && (
            <p className="py-2 text-ui-sm text-muted-foreground">
              {filter === "closed" ? "还没有已关闭的问题。" : "没有等你决定的问题。"}
            </p>
          )}
          {visible.map((view) => (
            <article
              key={view.issue.id}
              data-issue-id={view.issue.id}
              className="space-y-2 border-t border-border/60 py-3 first:border-t-0 first:pt-0"
            >
              <div className="flex flex-wrap items-center gap-2">
                <h5 className="min-w-0 break-words font-medium">
                  问题 {view.issue.number}：{view.issue.title}
                </h5>
                {view.issue.blocking && <Badge variant="warning">blocking</Badge>}
                <Badge variant="outline">{view.state}</Badge>
              </div>
              {!thread && (
                <p className="break-all text-ui-xs text-muted-foreground">
                  会话：{view.issue.thread_id}
                </p>
              )}
              {view.issue.body && (
                <p className="whitespace-pre-wrap break-words text-ui-sm">{view.issue.body}</p>
              )}
              {view.answer && (
                <p className="whitespace-pre-wrap break-words text-ui-sm">
                  用户答复：{view.answer.body}
                </p>
              )}
              {canReply(view) && (
                <form
                  className="space-y-2"
                  onSubmit={(event) => {
                    event.preventDefault();
                    if (!send.isPending && drafts[view.issue.id]?.trim())
                      send.mutate([{ issue: view.issue.id, answer: drafts[view.issue.id]! }]);
                  }}
                >
                  <label className="block space-y-1">
                    <span className="text-ui-xs text-muted-foreground">用户答复</span>
                    <Textarea
                      aria-label={`答复问题 ${view.issue.number}`}
                      value={drafts[view.issue.id] ?? ""}
                      disabled={send.isPending}
                      onChange={(event) => change(view.issue.id, event.target.value)}
                    />
                  </label>
                  <Button
                    size="sm"
                    type="submit"
                    disabled={!drafts[view.issue.id]?.trim() || send.isPending}
                  >
                    {send.isPending ? "发送中…" : "发送答复"}
                  </Button>
                </form>
              )}
              <IssueDisposition view={view} />
            </article>
          ))}
        </div>
      )}
      <footer className="shrink-0 space-y-2 border-t border-border/60 pt-2">
        {draftError && (
          <p role="alert" className="text-ui-xs text-destructive">
            {draftError}
          </p>
        )}
        {send.error && (
          <p role="alert" className="text-ui-xs text-destructive">
            {send.error.message}
          </p>
        )}
        {replies.length >= 2 && (
          <div className="flex flex-wrap items-center gap-2">
            <Select
              items={[
                { value: "bundle", label: "打包发送" },
                { value: "individual", label: "逐个发送" },
              ]}
              value={mode}
              disabled={send.isPending}
              onValueChange={(value) => {
                if (value === "bundle" || value === "individual") setMode(value);
              }}
            >
              <SelectTrigger aria-label="发送方式" size="xs" className="w-auto">
                <SelectValue />
              </SelectTrigger>
              <SelectPopup surface="composer">
                <SelectItem value="bundle">打包发送</SelectItem>
                <SelectItem value="individual">逐个发送</SelectItem>
              </SelectPopup>
            </Select>
            <Button size="sm" disabled={send.isPending} onClick={() => send.mutate(replies)}>
              {send.isPending
                ? "发送中…"
                : `${mode === "bundle" ? "打包发送" : "逐个发送"}（${replies.length}）`}
            </Button>
          </div>
        )}
      </footer>
    </aside>
  );
}
