import type { A2AGateRequest, A2AGateResult, A2ATask } from "@synara/contracts";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "../components/ui/button";
import { requestA2A } from "./api";

/** Inline in the gate bar: only the one move the current state allows. */
export function GateActions({ task, observerFailed }: { task: A2ATask; observerFailed: boolean }) {
  const queryClient = useQueryClient();
  const mutation = useMutation({
    mutationFn: async (request: A2AGateRequest) => {
      const result = await requestA2A<A2AGateResult>("/api/a2a", request);
      if (!result.ok) throw new Error(result.error ?? "门禁拒绝请求");
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: ["a2a-task", task.task_id] }),
  });
  const attempt = task.current_attempt;
  const call = (command: "verify" | "integrate" | "reclaim") => {
    if (!attempt || mutation.isPending || observerFailed) return;
    mutation.mutate({ command, task: task.task_id, attempt: attempt.attempt_id });
  };
  return (
    <>
      {task.state === "claimed" && <span className="text-muted-foreground">等待显式交付</span>}
      {task.state === "submitted" && (
        <Button
          size="xs"
          variant="outline"
          disabled={!attempt || mutation.isPending || observerFailed}
          onClick={() => call("verify")}
        >
          验收候选
        </Button>
      )}
      {task.state === "verified" && (
        <Button
          size="xs"
          disabled={!attempt || mutation.isPending || observerFailed}
          onClick={() => call("integrate")}
        >
          集成候选
        </Button>
      )}
      {task.state === "accepted" && attempt && !attempt.reclaimed && (
        <Button
          size="xs"
          variant="outline"
          disabled={mutation.isPending || observerFailed}
          onClick={() => call("reclaim")}
        >
          回收执行者
        </Button>
      )}
      {mutation.error && (
        <span role="alert" className="text-destructive">
          {mutation.error.message}
        </span>
      )}
    </>
  );
}
