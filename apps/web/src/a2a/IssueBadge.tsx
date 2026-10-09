import { Badge } from "../components/ui/badge";
import { useAllIssues } from "./useIssues";

export function IssueBadge({ project, thread }: { project?: string; thread?: string }) {
  const { issues, ready } = useAllIssues();
  const count = issues.filter(
    (item) =>
      item.view.state === "等你决定" &&
      (project === undefined || item.projectId === project) &&
      (thread === undefined || item.view.issue.thread_id === thread),
  ).length;
  if (!ready || !count) return null;
  return (
    <Badge variant="warning" aria-label={`等你决定 ${count} 题`} title={`${count} 个问题等你决定`}>
      {count}
    </Badge>
  );
}
