import { type A2AMembershipResult, type A2ATaskMembership, type ThreadId } from "@synara/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import ChatView from "../components/ChatView";
import { PanelStateMessage } from "../components/chat/PanelStateMessage";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { isOrdinarySpaceProject } from "../lib/spaces";
import { useStore } from "../store";
import { createThreadShellsSelector } from "../storeSelectors";
import { retainThreadDetailSubscription } from "../threadDetailSubscriptionRetention";
import { useWorkspacePathsStore } from "../workspacePathsStore";
import { GateState } from "./GateStatus";
import { GateActions } from "./GateActions";
import { MembershipEditor } from "./MembershipEditor";
import { requestA2A } from "./api";
import { useGateTask } from "./useGateTask";
import { HumanObserverStatus } from "./HumanObserverStatus";
import type { Project } from "../types";

const selectThreadShells = createThreadShellsSelector();

function NewTask({
  project,
  onSaved,
  onClose,
}: {
  project: Project;
  onSaved: (task: A2ATaskMembership) => void;
  onClose: () => void;
}) {
  const [title, setTitle] = useState("");
  const [taskId, setTaskId] = useState("");
  const [generatedTaskId] = useState(() => crypto.randomUUID());
  const mutation = useMutation({
    mutationFn: async () => {
      const task: A2ATaskMembership = {
        taskId: taskId.trim() || generatedTaskId,
        projectId: project.id,
        title: title.trim(),
        revision: 0,
        members: [],
      };
      const result = await requestA2A<A2AMembershipResult>("/api/a2a/membership", {
        command: "save",
        task,
      });
      if (!result.ok || !result.task) throw new Error(result.error ?? "任务保存没有返回归属");
      return result.task;
    },
    onSuccess: onSaved,
  });
  return (
    <form
      aria-label="添加任务"
      className="space-y-3 p-4"
      onSubmit={(event) => {
        event.preventDefault();
        if (!mutation.isPending) mutation.mutate();
      }}
    >
      <h2 className="font-medium">{project.name} · 添加任务</h2>
      <label className="block space-y-1">
        <span className="text-ui-xs text-muted-foreground">任务标题</span>
        <Input
          required
          maxLength={240}
          value={title}
          onChange={(event) => setTitle(event.target.value)}
        />
      </label>
      <label className="block space-y-1">
        <span className="text-ui-xs text-muted-foreground">任务 ID（已有门禁任务时填写）</span>
        <Input
          maxLength={128}
          value={taskId}
          onChange={(event) => setTaskId(event.target.value)}
          placeholder="留空创建未挂合同的任务"
        />
      </label>
      {mutation.error && (
        <p role="alert" className="text-ui-xs text-destructive">
          {mutation.error.message}
        </p>
      )}
      <div className="flex gap-2">
        <Button type="submit" size="sm" disabled={mutation.isPending || !title.trim()}>
          添加任务
        </Button>
        <Button
          type="button"
          size="sm"
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

export function TaskWindow() {
  const allProjects = useStore((state) => state.projects);
  const threads = useStore(selectThreadShells);
  const homeDir = useWorkspacePathsStore((state) => state.homeDir);
  const chatWorkspaceRoot = useWorkspacePathsStore((state) => state.chatWorkspaceRoot);
  const studioWorkspaceRoot = useWorkspacePathsStore((state) => state.studioWorkspaceRoot);
  const groupsWorkspaceRoot = useWorkspacePathsStore((state) => state.groupsWorkspaceRoot);
  const projects = allProjects.filter((project) =>
    isOrdinarySpaceProject(project, {
      homeDir,
      chatWorkspaceRoot,
      studioWorkspaceRoot,
      groupsWorkspaceRoot,
    }),
  );
  const [selected, setSelected] = useState<string | null>(null);
  const [creating, setCreating] = useState<Project | null>(null);
  const [editing, setEditing] = useState(false);
  const [focused, setFocused] = useState<ThreadId | null>(null);
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: ["a2a-memberships"],
    retry: false,
    queryFn: async ({ signal }) => {
      const result = await requestA2A<A2AMembershipResult>(
        "/api/a2a/membership",
        undefined,
        signal,
      );
      if (!result.ok || !result.tasks) throw new Error(result.error ?? "归属读取失败");
      return result.tasks;
    },
    refetchInterval: 1000,
  });
  const task = query.error
    ? undefined
    : (query.data?.find((task) => task.taskId === selected) ?? query.data?.[0]);
  const visibleMembers = creating ? undefined : task?.members;
  useEffect(() => {
    const releases = visibleMembers?.map((member) =>
      retainThreadDetailSubscription(member.threadId),
    );
    return () => releases?.forEach((release) => release());
  }, [visibleMembers]);
  const gate = useGateTask(task?.taskId ?? null, task?.projectId ?? null);
  const focus = task?.members.some((member) => member.threadId === focused)
    ? focused
    : task?.members[0]?.threadId;
  const saved = (saved: A2ATaskMembership) => {
    setSelected(saved.taskId);
    setCreating(null);
    setEditing(false);
    void queryClient.invalidateQueries({ queryKey: ["a2a-memberships"] });
  };

  return (
    <main aria-label="任务窗口" className="flex min-h-0 min-w-0 flex-1 text-ui">
      <nav
        aria-label="项目与任务"
        className="flex w-56 shrink-0 flex-col gap-3 overflow-y-auto border-r border-border p-3"
      >
        <h1 className="font-medium">任务窗口</h1>
        {query.error && (
          <p role="alert" className="text-ui-xs text-destructive">
            {query.error.message}
          </p>
        )}
        {projects.map((project) => (
          <section key={project.id}>
            <div className="mb-1 flex min-w-0 items-center justify-between gap-2">
              <h2 className="truncate text-ui-sm font-medium" title={project.name}>
                {project.name}
              </h2>
              <Button
                size="xs"
                variant="ghost"
                aria-label={`为${project.name}添加任务`}
                onClick={() => {
                  setCreating(project);
                  setEditing(false);
                }}
              >
                ＋
              </Button>
            </div>
            {query.data
              ?.filter((task) => task.projectId === project.id)
              .map((item) => (
                <Button
                  key={item.taskId}
                  variant={item.taskId === task?.taskId ? "secondary" : "ghost"}
                  className="w-full justify-start"
                  aria-current={item.taskId === task?.taskId ? "page" : undefined}
                  onClick={() => {
                    setSelected(item.taskId);
                    setCreating(null);
                    setEditing(false);
                  }}
                >
                  <span className="truncate">{item.title}</span>
                </Button>
              ))}
          </section>
        ))}
        {projects.length === 0 && (
          <p className="text-ui-xs text-muted-foreground">先在 Synara 中打开仓库项目。</p>
        )}
      </nav>
      <section className="flex min-h-0 min-w-0 flex-1 flex-col">
        {creating ? (
          <NewTask
            key={creating.id}
            project={creating}
            onSaved={saved}
            onClose={() => setCreating(null)}
          />
        ) : task ? (
          <>
            <header className="flex shrink-0 items-center justify-between gap-3 border-b border-border px-4 py-3">
              <div className="min-w-0">
                <h2 className="truncate font-medium">{task.title}</h2>
                <p className="mt-0.5 truncate font-mono text-ui-xs text-muted-foreground">
                  {task.taskId}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <span className="text-ui-xs text-muted-foreground">
                  {task.members.length} 个 agent 会话
                </span>
                <Button size="sm" variant="outline" onClick={() => setEditing(!editing)}>
                  会话归属
                </Button>
              </div>
            </header>
            {gate.error ? (
              <p
                role="alert"
                className="border-b border-border px-4 py-2 text-ui-xs text-destructive"
              >
                门禁读取失败：{gate.error.message}
              </p>
            ) : gate.data ? (
              gate.data.task ? (
                <>
                  <GateState task={gate.data.task} />
                  <GateActions
                    task={gate.data.task}
                    observerFailed={gate.data.observer.state === "failed"}
                  />
                </>
              ) : (
                <p className="border-b border-border px-4 py-2 text-ui-xs text-muted-foreground">
                  未挂验收合同
                </p>
              )
            ) : (
              <p className="border-b border-border px-4 py-2 text-ui-xs text-muted-foreground">
                读取门禁…
              </p>
            )}
            {gate.data && !gate.error && <HumanObserverStatus observer={gate.data.observer} />}
            {editing && (
              <MembershipEditor
                key={task.taskId}
                task={task}
                threads={threads}
                onSaved={saved}
                onClose={() => setEditing(false)}
              />
            )}
            {task.members.length ? (
              <div className="flex min-h-0 flex-1 overflow-x-auto">
                {task.members.map((member) => {
                  const thread = threads.find((thread) => thread.id === member.threadId);
                  const interventions = gate.error
                    ? []
                    : (gate.data?.interventions.filter(
                        (event) => event.threadId === member.threadId,
                      ) ?? []);
                  return (
                    <section
                      key={member.threadId}
                      aria-label={`${member.role} agent 会话`}
                      className="flex min-h-0 min-w-80 flex-1 flex-col border-r border-border last:border-r-0"
                      onFocusCapture={() => setFocused(member.threadId)}
                      onPointerDown={() => setFocused(member.threadId)}
                    >
                      <header className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2 text-ui-xs">
                        <Badge variant="outline">{member.role}</Badge>
                        <h3 className="min-w-0 flex-1 truncate">
                          {thread?.title ?? member.threadId}
                        </h3>
                        {interventions.length > 0 ? (
                          <Badge
                            variant="warning"
                            title={interventions[interventions.length - 1]?.time}
                          >
                            人工介入 · {interventions.length}
                          </Badge>
                        ) : (
                          <span className="text-muted-foreground">人工介入 —</span>
                        )}
                        {thread && (
                          <Link
                            to="/$threadId"
                            params={{ threadId: thread.id }}
                            className="text-muted-foreground hover:text-foreground focus-visible:underline"
                          >
                            打开会话
                          </Link>
                        )}
                      </header>
                      {interventions.length > 0 && (
                        <details className="border-b border-border px-3 py-2 text-ui-xs">
                          <summary className="cursor-pointer text-warning">
                            查看人工介入记录
                          </summary>
                          {interventions.map((event) => (
                            <p key={event.eventId} className="mt-2 whitespace-pre-wrap break-words">
                              <span className="text-muted-foreground">
                                {event.time} · {event.attemptId}
                              </span>
                              <br />
                              {event.text}
                            </p>
                          ))}
                        </details>
                      )}
                      {thread && thread.projectId === task.projectId ? (
                        <ChatView
                          threadId={member.threadId}
                          hideHeader
                          paneScopeId={`a2a:${task.taskId}:${member.threadId}`}
                          surfaceMode="split"
                          isFocusedPane={focus === member.threadId}
                        />
                      ) : (
                        <PanelStateMessage fill="flex">会话不可用，请核对归属。</PanelStateMessage>
                      )}
                    </section>
                  );
                })}
              </div>
            ) : (
              <PanelStateMessage fill="flex">
                点击“会话归属”添加本项目的 agent 会话。
              </PanelStateMessage>
            )}
          </>
        ) : (
          <PanelStateMessage fill="flex">选择项目并添加任务。</PanelStateMessage>
        )}
      </section>
    </main>
  );
}
