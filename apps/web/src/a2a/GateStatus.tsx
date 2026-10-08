import { useQuery } from "@tanstack/react-query";
import type { A2AGateResult, A2ATask } from "@synara/contracts";
import { Badge } from "../components/ui/badge";
import { resolveWsHttpUrl } from "../lib/wsHttpUrl";
import { humanObserverView } from "./humanObserver";
import { HumanObserverStatus } from "./HumanObserverStatus";

export function GateStatus({ threadId }: { threadId: string }) {
  const query = useQuery({
    queryKey: ["a2a-gate", threadId],
    queryFn: async ({ signal }) => {
      const response = await fetch(
        resolveWsHttpUrl(`/api/a2a?thread=${encodeURIComponent(threadId)}`),
        { credentials: "include", signal },
      );
      if (!response.ok) throw new Error(`门禁状态读取失败 (${response.status})`);
      const result = (await response.json()) as A2AGateResult;
      if (!result.ok) throw new Error(result.error ?? "门禁状态未知");
      return { task: result.task ?? null, observer: humanObserverView(result) };
    },
    refetchInterval: 1000,
  });
  if (query.error)
    return (
      <p role="alert" className="border-b border-border px-4 py-2 text-ui-xs text-destructive">
        {query.error.message}
      </p>
    );
  const task = query.data?.task;
  if (!task) return null;
  return (
    <>
      <GateState task={task} />
      <HumanObserverStatus observer={query.data!.observer} />
    </>
  );
}

export function GateState({ task }: { task: A2ATask }) {
  const states = ["claimed", "submitted", "verified", "accepted"];
  return (
    <section
      aria-label="受管任务门禁"
      className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-2 text-ui-xs"
    >
      <span className="mr-2 font-medium">任务 · {task.task_id}</span>
      {states.map((state) => (
        <Badge
          key={state}
          aria-current={task.state === state ? "step" : undefined}
          variant={task.state === state ? (state === "accepted" ? "success" : "info") : "outline"}
        >
          {state}
        </Badge>
      ))}
      {!states.includes(task.state) && (
        <Badge variant="warning" aria-current="step">
          {task.state}
        </Badge>
      )}
      {task.verification &&
        ["failed", "merge_failed", "unknown", "interrupted"].includes(task.verification.state) && (
          <details className="w-full text-destructive">
            <summary className="cursor-pointer">失败原因 · {task.verification.state}</summary>
            <pre className="mt-2 max-h-48 overflow-y-auto whitespace-pre-wrap break-all font-mono text-ui-xs">
              {task.verification.result?.stderr ||
                task.verification.result?.stdout ||
                "验收没有完整结果"}
            </pre>
          </details>
        )}
      {task.current_attempt?.reclaimed && (
        <span className="text-muted-foreground">worker 已回收</span>
      )}
    </section>
  );
}
