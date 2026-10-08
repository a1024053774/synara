import type {
  A2AMemberRole,
  A2AMembershipResult,
  A2ATaskMembership,
  ThreadId,
} from "@synara/contracts";
import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "../components/ui/select";
import type { ThreadShell } from "../types";
import { requestA2A } from "./api";

const roles: ReadonlyArray<A2AMemberRole> = ["controller", "worker", "reviewer", "monitor"];

export function MembershipEditor({
  task,
  threads,
  onSaved,
  onClose,
}: {
  task: A2ATaskMembership;
  threads: ReadonlyArray<ThreadShell>;
  onSaved: (task: A2ATaskMembership) => void;
  onClose: () => void;
}) {
  // Keep the opened revision while editing. A concurrent save must be rejected by CAS.
  const [draft, setDraft] = useState(task);
  const [threadId, setThreadId] = useState<ThreadId | null>(null);
  const [role, setRole] = useState<A2AMemberRole>("worker");
  const mutation = useMutation({
    mutationFn: async () => {
      const result = await requestA2A<A2AMembershipResult>("/api/a2a/membership", {
        command: "save",
        task: draft,
      });
      if (!result.ok || !result.task) throw new Error(result.error ?? "归属保存没有返回任务");
      return result.task;
    },
    onSuccess: onSaved,
  });
  const available = threads.filter(
    (thread) =>
      thread.projectId === task.projectId &&
      !draft.members.some((member) => member.threadId === thread.id),
  );
  return (
    <form
      aria-label="编辑会话归属"
      className="space-y-3 border-b border-border p-4 text-ui"
      onSubmit={(event) => {
        event.preventDefault();
        if (!mutation.isPending) mutation.mutate();
      }}
    >
      <label className="block space-y-1">
        <span className="text-ui-xs text-muted-foreground">任务标题</span>
        <Input
          required
          maxLength={240}
          value={draft.title}
          onChange={(event) => setDraft({ ...draft, title: event.target.value })}
        />
      </label>
      <div className="flex flex-wrap items-center gap-2">
        {draft.members.map((member) => (
          <Button
            key={member.threadId}
            variant="outline"
            size="sm"
            type="button"
            onClick={() =>
              setDraft({
                ...draft,
                members: draft.members.filter((item) => item.threadId !== member.threadId),
              })
            }
          >
            {threads.find((thread) => thread.id === member.threadId)?.title ?? member.threadId} ·{" "}
            {member.role} ×
          </Button>
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Select value={threadId} onValueChange={(value) => setThreadId(value as ThreadId | null)}>
          <SelectTrigger aria-label="选择 agent 会话">
            <SelectValue placeholder="选择已有会话" />
          </SelectTrigger>
          <SelectPopup surface="composer">
            {available.map((thread) => (
              <SelectItem key={thread.id} value={thread.id}>
                {thread.title}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
        <Select
          value={role}
          onValueChange={(value) => {
            if (value) setRole(value);
          }}
        >
          <SelectTrigger aria-label="会话角色">
            <SelectValue />
          </SelectTrigger>
          <SelectPopup surface="composer">
            {roles.map((role) => (
              <SelectItem key={role} value={role}>
                {role}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={!threadId}
          onClick={() => {
            if (!threadId) return;
            setDraft({ ...draft, members: [...draft.members, { threadId, role }] });
            setThreadId(null);
          }}
        >
          添加会话
        </Button>
      </div>
      {available.length === 0 && (
        <p className="text-ui-xs text-muted-foreground">可在项目中创建会话后再添加归属。</p>
      )}
      {mutation.error && (
        <p role="alert" className="text-ui-xs text-destructive">
          {mutation.error.message}
        </p>
      )}
      <div className="flex gap-2">
        <Button type="submit" size="sm" disabled={mutation.isPending || !draft.title.trim()}>
          保存归属
        </Button>
        <Button
          size="sm"
          type="button"
          variant="ghost"
          disabled={mutation.isPending}
          onClick={onClose}
        >
          取消
        </Button>
      </div>
    </form>
  );
}
