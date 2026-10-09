import type { A2AGateResult } from "@synara/contracts";

export interface HumanIntervention {
  eventId: string;
  threadId: string;
  messageId: string;
  attemptId: string;
  time: string;
  text: string;
}

/** Reads the T-037 event contract; historical attempts keep their original thread. */
export function humanInterventions(
  events: NonNullable<A2AGateResult["events"]>,
  taskId: string,
): ReadonlyArray<HumanIntervention> {
  const seen = new Set<string>();
  const result: HumanIntervention[] = [];
  for (const event of events) {
    if (event.type !== "human_intervention") continue;
    const details = event.details as Record<string, unknown> | null;
    if (!details || typeof details !== "object") throw new Error("人工介入事件格式错误");
    if (typeof details.dispatch_origin !== "string") throw new Error("人工介入事件缺少来源");
    if (details.dispatch_origin !== "user") continue;
    if (!("task" in event) || typeof event.task !== "string" || typeof details.task_id !== "string")
      throw new Error("人工介入事件缺少任务绑定");
    if (event.task !== taskId || details.task_id !== taskId) continue;
    if (
      typeof details.event_id !== "string" ||
      !details.event_id ||
      typeof details.thread_id !== "string" ||
      !details.thread_id ||
      (details.form === undefined || details.form === "message" || details.form === "answer"
        ? typeof details.message_id !== "string" || !details.message_id
        : details.message_id !== null &&
          (typeof details.message_id !== "string" || !details.message_id)) ||
      typeof details.attempt_id !== "string" ||
      !details.attempt_id ||
      typeof details.text !== "string"
    )
      throw new Error("人工介入事件缺少身份或正文");
    if (!("attempt" in event) || event.attempt !== details.attempt_id)
      throw new Error("人工介入事件的 attempt 绑定不一致");
    if (seen.has(details.event_id)) continue;
    seen.add(details.event_id);
    result.push({
      eventId: details.event_id,
      threadId: details.thread_id,
      messageId: typeof details.message_id === "string" ? details.message_id : "",
      attemptId: details.attempt_id,
      time: event.time,
      text: details.text,
    });
  }
  return result;
}
