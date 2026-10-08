import { useQuery } from "@tanstack/react-query";
import type { A2AGateResult, A2ATask } from "@synara/contracts";
import { createContext, useContext, useState, type ReactNode } from "react";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../components/ui/collapsible";
import { DisclosureChevron } from "../components/ui/DisclosureChevron";
import { StatusChip } from "../components/ui/status-chip";
import { resolveWsHttpUrl } from "../lib/wsHttpUrl";
import { cn } from "../lib/utils";
import { humanObserverView, type HumanObserverView } from "./humanObserver";
import { ObserverFailureNote, ObserverIndicator } from "./HumanObserverStatus";

/**
 * The task window shows the gate once, in its own header. ChatView renders a
 * GateStatus per thread; inside the task window that row stays silent.
 */
export const GateShownByTaskWindow = createContext(false);

const STEPS = ["ready", "claimed", "submitted", "verified", "accepted"] as const;
const VERIFICATION_FAILURES: Record<string, string> = {
  failed: "验收未通过",
  merge_failed: "集成冲突",
  unknown: "验收结果未知",
  interrupted: "验收中断",
};

export function GateStatus({ threadId }: { threadId: string }) {
  const shownByTaskWindow = useContext(GateShownByTaskWindow);
  return shownByTaskWindow ? null : <ThreadGateStatus threadId={threadId} />;
}

function ThreadGateStatus({ threadId }: { threadId: string }) {
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
    <div className="border-b border-border">
      <GateBar task={task} observer={query.data!.observer} />
    </div>
  );
}

function stepDotClass(position: "done" | "current" | "todo", failed: boolean, accepted: boolean) {
  if (position === "done") return "bg-muted-foreground/50";
  if (position === "todo") return "border border-muted-foreground/40";
  if (failed) return "bg-status-failure";
  return accepted ? "bg-status-success" : "bg-info";
}

/** One row: where the task is in the gate, who can move it, and whether input is being recorded. */
export function GateBar({
  task,
  observer,
  actions,
}: {
  task: A2ATask;
  observer: HumanObserverView;
  actions?: ReactNode;
}) {
  const known = (STEPS as readonly string[]).includes(task.state);
  const current = known ? STEPS.indexOf(task.state as (typeof STEPS)[number]) : STEPS.length;
  const steps: string[] = known ? [...STEPS] : [...STEPS, task.state];
  const failure =
    task.verification && task.verification.state in VERIFICATION_FAILURES
      ? task.verification
      : undefined;
  return (
    <section aria-label="受管任务门禁" className="text-ui-xs">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-2">
        <ol className="m-0 flex list-none items-center gap-1.5 p-0">
          {steps.map((step, index) => {
            const position = index < current ? "done" : index === current ? "current" : "todo";
            return (
              <li key={step} className="flex items-center gap-1.5">
                {index > 0 && <span aria-hidden className="h-px w-3 bg-border" />}
                <span
                  aria-current={position === "current" ? "step" : undefined}
                  className={cn(
                    "flex items-center gap-1.5",
                    position === "current"
                      ? "font-medium text-foreground"
                      : "text-muted-foreground",
                    position === "todo" && "text-muted-foreground/60",
                  )}
                >
                  <span
                    aria-hidden
                    className={cn(
                      "size-1.5 shrink-0 rounded-full",
                      stepDotClass(position, failure !== undefined, task.state === "accepted"),
                    )}
                  />
                  {step}
                </span>
              </li>
            );
          })}
        </ol>
        {task.current_attempt?.reclaimed && (
          <span className="text-muted-foreground">worker 已回收</span>
        )}
        <div className="ml-auto flex flex-wrap items-center gap-x-3 gap-y-2">
          {actions}
          <ObserverIndicator observer={observer} />
        </div>
      </div>
      {failure && <FailureReason verification={failure} />}
      {observer.state === "failed" && <ObserverFailureNote observer={observer} />}
    </section>
  );
}

function FailureReason({ verification }: { verification: NonNullable<A2ATask["verification"]> }) {
  const [open, setOpen] = useState(false);
  const output =
    verification.result?.stderr?.trim() ||
    verification.result?.stdout?.trim() ||
    "验收没有完整结果";
  const summary = output.replace(/\s+/g, " ");
  return (
    <Collapsible open={open} onOpenChange={setOpen} className="border-t border-border/60">
      <CollapsibleTrigger
        title={verification.state}
        className="flex w-full min-w-0 items-center gap-2 px-4 py-1.5 text-left hover:bg-muted/40"
      >
        <DisclosureChevron open={open} className="size-3 shrink-0 text-muted-foreground" />
        <StatusChip dotClassName="bg-status-failure" className="shrink-0 font-medium">
          失败原因 · {VERIFICATION_FAILURES[verification.state]}
        </StatusChip>
        {!open && (
          <span className="min-w-0 flex-1 truncate font-mono text-muted-foreground">{summary}</span>
        )}
      </CollapsibleTrigger>
      <CollapsiblePanel>
        <pre className="max-h-48 overflow-y-auto whitespace-pre-wrap break-all border-t border-border/60 bg-muted/30 px-4 py-2 font-mono text-ui-xs text-muted-foreground">
          {output}
        </pre>
      </CollapsiblePanel>
    </Collapsible>
  );
}
