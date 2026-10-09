import { Schema } from "effect";

export const A2ASessionPreset = Schema.Literals([
  "executor",
  "ideation",
  "worker",
  "reviewer",
  "monitor",
]);
export type A2ASessionPreset = typeof A2ASessionPreset.Type;
export const A2AInboxKind = Schema.Literals([
  "assign",
  "revise",
  "cancel",
  "stop",
  "report",
  "needs-decision",
  "issue",
  "disposition",
  "answer",
  "ack",
]);
export const A2AInboxRequest = Schema.Struct({
  command: Schema.Literals(["inbox_send", "inbox_list", "inbox_ack"]),
  from: Schema.optional(Schema.String),
  to: Schema.optional(Schema.String),
  kind: Schema.optional(A2AInboxKind),
  reply_to: Schema.optional(Schema.NullOr(Schema.String)),
  refs: Schema.optional(Schema.Array(Schema.String)),
  body: Schema.optional(Schema.String),
  role: Schema.optional(Schema.String),
  id: Schema.optional(Schema.String),
  title: Schema.optional(Schema.String),
  blocking: Schema.optional(Schema.Boolean),
  action: Schema.optional(
    Schema.Literals(["close", "dismiss", "forward", "snooze", "reopen", "needs-user", "delivered"]),
  ),
  reason: Schema.optional(Schema.String),
  basis: Schema.optional(Schema.String),
  certainty: Schema.optional(Schema.Literal("relayed")),
  bundle_id: Schema.optional(Schema.String),
});
export type A2AInboxRequest = typeof A2AInboxRequest.Type;
export const A2AStopRequest = Schema.Struct({
  command: Schema.Literal("stop"),
  thread: Schema.String,
  stop_id: Schema.String,
});
export type A2AStopRequest = typeof A2AStopRequest.Type;

export interface A2AInboxEntry {
  id: string;
  schema: 1;
  kind: typeof A2AInboxKind.Type;
  from: string;
  to: string;
  reply_to: string | null;
  refs: ReadonlyArray<string>;
  created_at: string;
  body: string;
  title?: string;
  blocking?: boolean;
  action?: string;
  reason?: string;
  basis?: string;
  certainty?: "relayed";
  bundle_id?: string;
}
export interface A2AInboxDelivery {
  state: "pending" | "delivered" | "undelivered" | "unknown";
  entry_id: string;
  created_at: string;
  thread?: string;
  message?: string;
  reason?: string;
}
