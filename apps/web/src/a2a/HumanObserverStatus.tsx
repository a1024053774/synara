import { Badge } from "../components/ui/badge";
import type { HumanObserverView } from "./humanObserver";

export function HumanObserverStatus({ observer }: { observer: HumanObserverView }) {
  return (
    <section
      aria-label="人工输入记录器状态"
      className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-2 text-ui-xs"
    >
      <Badge
        variant={
          observer.state === "healthy"
            ? "success"
            : observer.state === "failed"
              ? "error"
              : "warning"
        }
        title={observer.updatedAt}
      >
        {observer.state === "missing"
          ? "人工输入记录器：未安装"
          : `人工输入记录器：${observer.state}`}
      </Badge>
      {observer.state === "failed" && (
        <>
          <span className="text-destructive">{observer.failureReason}</span>
          <span className="text-destructive">
            门禁会拒绝改变任务状态的操作（human_input_observer_failed）。
          </span>
        </>
      )}
    </section>
  );
}
