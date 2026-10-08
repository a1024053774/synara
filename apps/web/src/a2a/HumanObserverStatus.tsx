import { StatusChip } from "../components/ui/status-chip";
import type { HumanObserverView } from "./humanObserver";

const OBSERVER_LABEL: Record<HumanObserverView["state"], string> = {
  missing: "未安装",
  starting: "启动中",
  healthy: "正常",
  stopped: "已停止",
  failed: "已失败",
};

/** Small status chip; the failure explanation lives in ObserverFailureNote. */
export function ObserverIndicator({ observer }: { observer: HumanObserverView }) {
  return (
    <span aria-label="人工输入记录器状态" title={observer.updatedAt}>
      <StatusChip
        dotClassName={
          observer.state === "healthy"
            ? "bg-status-success"
            : observer.state === "failed"
              ? "bg-status-failure"
              : "bg-warning"
        }
        className="text-ui-xs text-muted-foreground"
      >
        人工输入记录器 · {OBSERVER_LABEL[observer.state]}
      </StatusChip>
    </span>
  );
}

export function ObserverFailureNote({ observer }: { observer: HumanObserverView }) {
  return (
    <p className="border-t border-border/60 bg-muted/30 px-4 py-1.5 text-muted-foreground">
      记录器没有在记录人工输入：{observer.failureReason}。恢复前，门禁拒绝改变任务状态的操作{" "}
      <code className="font-mono text-ui-2xs">human_input_observer_failed</code>。
    </p>
  );
}
