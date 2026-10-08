import { describe, expect, it } from "vitest";
import { humanInterventions } from "./humanIntervention";

// Explicit protocol fixtures from T-037's contract. No real input-listener claim.
const worker = {
  seq: 11,
  time: "2026-10-08T01:02:03Z",
  task: "task-A",
  attempt: "old-attempt-A",
  type: "human_intervention",
  details: {
    task_id: "task-A",
    attempt_id: "old-attempt-A",
    session_id: "session-A",
    fence: 1,
    spec_rev: 1,
    thread_id: "worker-A",
    turn_id: null,
    message_id: "message-A",
    event_id: "user-event-A",
    source_sequence: 20,
    created_at: "2026-10-08T01:02:03Z",
    dispatch_origin: "user",
    text: "检查分页边界",
  },
};
const reviewer = {
  ...worker,
  seq: 15,
  attempt: "review-attempt-R",
  time: "2026-10-08T01:03:04Z",
  details: {
    ...worker.details,
    attempt_id: "review-attempt-R",
    thread_id: "reviewer-R",
    event_id: "user-event-R",
    message_id: "message-R",
    text: "只审查，不集成",
  },
};

describe("human intervention protocol fixtures", () => {
  it("deduplicates event_id, preserves the historical thread, and excludes other tasks and agent input", () => {
    const events = [
      worker,
      { ...worker, seq: 12 },
      {
        ...worker,
        seq: 13,
        details: { ...worker.details, event_id: "agent-event", dispatch_origin: "agent" },
      },
      {
        ...worker,
        seq: 14,
        task: "task-B",
        details: { ...worker.details, task_id: "task-B", event_id: "foreign-event" },
      },
      reviewer,
      { seq: 16, time: "2026-10-08T01:04:00Z", type: "submitted", details: {} },
    ];
    expect(humanInterventions(events, "task-A")).toEqual([
      {
        eventId: "user-event-A",
        threadId: "worker-A",
        messageId: "message-A",
        attemptId: "old-attempt-A",
        time: "2026-10-08T01:02:03Z",
        text: "检查分页边界",
      },
      {
        eventId: "user-event-R",
        threadId: "reviewer-R",
        messageId: "message-R",
        attemptId: "review-attempt-R",
        time: "2026-10-08T01:03:04Z",
        text: "只审查，不集成",
      },
    ]);
    expect(humanInterventions(events, "task-sentinel-unseen")).toEqual([]);
  });
  it("does not silently hide malformed or inconsistently bound human records", () => {
    expect(() => humanInterventions([{ ...worker, details: null }], "task-A")).toThrow();
    expect(() =>
      humanInterventions(
        [{ ...worker, details: { ...worker.details, thread_id: null } }],
        "task-A",
      ),
    ).toThrow();
    expect(() =>
      humanInterventions([{ ...worker, details: { ...worker.details, message_id: "" } }], "task-A"),
    ).toThrow();
    const mismatched = { ...worker, attempt: "another-attempt" };
    expect(() => humanInterventions([mismatched], "task-A")).toThrow();
  });
});
