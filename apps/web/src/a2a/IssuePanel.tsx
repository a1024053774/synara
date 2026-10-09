import type { A2AGateResult, A2AIssueRecord } from "@synara/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Textarea } from "../components/ui/textarea";
import { requestA2A } from "./api";

function IssueReply({ issue }: { issue: A2AIssueRecord }) {
  const [answer, setAnswer] = useState("");
  const client = useQueryClient();
  const send = useMutation({
    mutationFn: async () => {
      const result = await requestA2A<A2AGateResult>("/api/a2a", {
        command: "answer_issue",
        task: issue.task_id,
        issue: issue.id,
        answer,
      });
      if (!result.ok) throw new Error(result.error ?? "答复未送达，请核对问题记录。");
      return result;
    },
    onSuccess: () => {
      setAnswer("");
      void client.invalidateQueries({ queryKey: ["a2a-issues", issue.task_id, issue.thread_id] });
      void client.invalidateQueries({ queryKey: ["a2a-task", issue.task_id] });
    },
  });
  return (
    <form
      className="space-y-2"
      onSubmit={(event) => {
        event.preventDefault();
        if (!send.isPending && answer.trim()) send.mutate();
      }}
    >
      <label className="block space-y-1">
        <span className="text-ui-xs text-muted-foreground">用户答复</span>
        <Textarea
          aria-label={`答复问题 ${issue.number}`}
          value={answer}
          onChange={(event) => setAnswer(event.target.value)}
          disabled={send.isPending}
        />
      </label>
      {send.error && (
        <p role="alert" className="text-ui-xs text-destructive">
          {send.error.message}
        </p>
      )}
      <Button size="sm" type="submit" disabled={!answer.trim() || send.isPending}>
        {send.isPending ? "发送中…" : "发送答复"}
      </Button>
    </form>
  );
}

export function IssuePanel({ task, thread }: { task: string; thread: string }) {
  const query = useQuery({
    queryKey: ["a2a-issues", task, thread],
    retry: false,
    queryFn: async ({ signal }) => {
      const result = await requestA2A<A2AGateResult>(
        `/api/a2a/issues?task=${encodeURIComponent(task)}&thread=${encodeURIComponent(thread)}`,
        undefined,
        signal,
      );
      if (!result.ok) {
        if (result.error === "unknown_task") return [];
        throw new Error(result.error ?? "问题读取失败");
      }
      return [...(result.issues ?? [])].sort(
        (a, b) =>
          Number(b.issue.blocking) - Number(a.issue.blocking) || a.issue.number - b.issue.number,
      );
    },
    refetchInterval: 1000,
  });
  if (!query.error && !query.data?.length) return null;
  return (
    <aside
      aria-label="问题上报"
      data-a2a-issues={thread}
      className="max-h-72 shrink-0 overflow-y-auto border-b border-border bg-muted/20 px-3 py-3 text-ui"
    >
      <h4 className="mb-2 font-medium">问题上报</h4>
      {query.error ? (
        <p role="alert" className="text-ui-xs text-destructive">
          {query.error.message}
        </p>
      ) : (
        query.data?.map(({ issue, state, answer }) => (
          <article
            key={issue.id}
            className="space-y-2 border-t border-border/60 py-3 first:border-t-0 first:pt-0"
          >
            <div className="flex flex-wrap items-center gap-2">
              <h5 className="min-w-0 break-words font-medium">
                问题 {issue.number}：{issue.title}
              </h5>
              {issue.blocking && <Badge variant="warning">blocking</Badge>}
              <Badge variant="outline">{state}</Badge>
            </div>
            {issue.body && (
              <p className="whitespace-pre-wrap break-words text-ui-sm">{issue.body}</p>
            )}
            {answer ? (
              <p className="whitespace-pre-wrap break-words text-ui-sm">用户答复：{answer.body}</p>
            ) : (
              <IssueReply issue={issue} />
            )}
          </article>
        ))
      )}
    </aside>
  );
}
