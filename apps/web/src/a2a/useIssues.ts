import type { A2AGateResult, A2AIssueView, A2AMembershipResult } from "@synara/contracts";
import { queryOptions, useQueries, useQuery } from "@tanstack/react-query";
import { requestA2A } from "./api";

export const membershipQueryOptions = queryOptions({
  queryKey: ["a2a-memberships"],
  retry: false,
  refetchInterval: 1000,
  refetchIntervalInBackground: true,
  queryFn: async ({ signal }) => {
    const result = await requestA2A<A2AMembershipResult>("/api/a2a/membership", undefined, signal);
    if (!result.ok || !result.tasks) throw new Error(result.error ?? "归属读取失败");
    return result.tasks;
  },
});

export function taskIssuesQueryOptions(task: string) {
  return queryOptions({
    queryKey: ["a2a-issues", task],
    retry: false,
    refetchInterval: 1000,
    refetchIntervalInBackground: true,
    queryFn: async ({ signal }) => {
      const result = await requestA2A<A2AGateResult>(
        `/api/a2a/issues?task=${encodeURIComponent(task)}`,
        undefined,
        signal,
      );
      if (!result.ok) {
        if (result.error === "unknown_task") return [];
        throw new Error(result.error ?? "问题读取失败");
      }
      return [...(result.issues ?? [])].sort(
        (a, b) =>
          Number(b.issue.blocking) - Number(a.issue.blocking) ||
          a.issue.thread_id.localeCompare(b.issue.thread_id) ||
          a.issue.number - b.issue.number,
      );
    },
  });
}

export function useAllIssues() {
  const memberships = useQuery(membershipQueryOptions);
  const queries = useQueries({
    queries: (memberships.data ?? []).map((task) => taskIssuesQueryOptions(task.taskId)),
  });
  const issues: { projectId: string; view: A2AIssueView }[] = queries.flatMap((query, index) =>
    (query.data ?? []).map((view) => ({ projectId: memberships.data![index]!.projectId, view })),
  );
  return {
    issues,
    ready: memberships.isSuccess && queries.every((query) => query.isSuccess),
    error: memberships.error ?? queries.find((query) => query.error)?.error,
  };
}
