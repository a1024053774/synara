import type { A2AGateResult } from "@synara/contracts";
import { useQuery } from "@tanstack/react-query";
import { requestA2A } from "./api";
import { humanInterventions } from "./humanIntervention";
import { humanObserverView } from "./humanObserver";

export function useGateTask(taskId: string | null, projectId: string | null) {
  return useQuery({
    queryKey: ["a2a-task", taskId, projectId],
    enabled: taskId !== null,
    retry: false,
    queryFn: async ({ signal }) => {
      const status = await requestA2A<A2AGateResult>(
        "/api/a2a",
        { command: "status", task: taskId },
        signal,
      );
      if (!status.ok) {
        if (status.error === "unknown_task")
          return { task: null, interventions: [], observer: humanObserverView(status) };
        throw new Error(status.error ?? "门禁状态读取失败");
      }
      if (!status.task || status.task.project_id !== projectId)
        throw new Error("门禁任务与项目不一致");
      const events = await requestA2A<A2AGateResult>(
        "/api/a2a",
        { command: "events", task: taskId },
        signal,
      );
      if (!events.ok || !events.events) throw new Error(events.error ?? "门禁事件读取失败");
      return {
        task: status.task,
        interventions: humanInterventions(events.events, status.task.task_id),
        observer: humanObserverView(events),
      };
    },
    refetchInterval: 1000,
  });
}
