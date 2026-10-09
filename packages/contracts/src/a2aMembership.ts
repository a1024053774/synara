import { Schema } from "effect";
import { NonNegativeInt, ProjectId, ThreadId, TrimmedNonEmptyString } from "./baseSchemas";

export const A2AMemberRole = Schema.Literals(["controller", "worker", "reviewer", "monitor"]);
export type A2AMemberRole = typeof A2AMemberRole.Type;

export const A2ATaskMembership = Schema.Struct({
  taskId: TrimmedNonEmptyString.check(Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/)),
  projectId: ProjectId,
  title: TrimmedNonEmptyString.check(Schema.isMaxLength(240)),
  revision: NonNegativeInt,
  members: Schema.Array(
    Schema.Struct({
      threadId: ThreadId,
      role: A2AMemberRole,
      endedAt: Schema.optional(Schema.String),
    }),
  ),
});
export type A2ATaskMembership = typeof A2ATaskMembership.Type;

export const A2AMembershipSaveRequest = Schema.Struct({
  command: Schema.Literal("save"),
  task: A2ATaskMembership,
});

export interface A2AMembershipResult {
  ok: boolean;
  tasks?: ReadonlyArray<A2ATaskMembership>;
  task?: A2ATaskMembership;
  error?: string;
}
