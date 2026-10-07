import { useQuery } from "@tanstack/react-query";
import type { A2AGateResult } from "@synara/contracts";
import { Badge } from "../components/ui/badge";
import { resolveWsHttpUrl } from "../lib/wsHttpUrl";

export function GateStatus({ threadId }: { threadId: string }) {
  const query = useQuery({
    queryKey: ["a2a-gate", threadId],
    queryFn: async ({ signal }) => {
      const response = await fetch(resolveWsHttpUrl(`/api/a2a?thread=${encodeURIComponent(threadId)}`), { credentials: "include", signal });
      if (!response.ok) throw new Error(`门禁状态读取失败 (${response.status})`);
      const result = await response.json() as A2AGateResult;
      if (!result.ok) throw new Error(result.error ?? "门禁状态未知");
      return result.task ?? null;
    },
    refetchInterval: 1000,
  });
  if (query.error) return <p role="alert" className="border-b border-border px-4 py-2 text-ui-xs text-destructive">{query.error.message}</p>;
  const task = query.data;
  if (!task) return null;
  const states = ["claimed", "submitted", "verified", "accepted"];
  return <section aria-label="受管任务门禁" className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-2 text-ui-xs">
    <span className="mr-2 font-medium">任务 · {task.task_id}</span>
    {states.map(state => <Badge key={state} variant={task.state === state ? (state === "accepted" ? "success" : "info") : "outline"}>{state}</Badge>)}
    {!states.includes(task.state) && <Badge variant="warning">{task.state}</Badge>}
    {task.current_attempt?.reclaimed && <span className="text-muted-foreground">worker 已回收</span>}
  </section>;
}
