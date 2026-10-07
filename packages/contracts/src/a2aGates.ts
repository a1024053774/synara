import { Schema } from "effect";

export const A2AGateRequest = Schema.Struct({
  command: Schema.Literals(["create", "dispatch", "submit", "verify", "integrate", "reclaim", "status", "events"]),
  task: Schema.String,
  repo: Schema.optional(Schema.String),
  project: Schema.optional(Schema.String),
  base: Schema.optional(Schema.String),
  oracle: Schema.optional(Schema.String),
  instructions: Schema.optional(Schema.String),
  attempt: Schema.optional(Schema.String),
  session: Schema.optional(Schema.String),
  fence: Schema.optional(Schema.Number),
  spec_rev: Schema.optional(Schema.Number),
  commit: Schema.optional(Schema.String),
});
export type A2AGateRequest = typeof A2AGateRequest.Type;

export interface A2AAttempt {
  task_id: string;
  attempt_id: string;
  session_id: string;
  fence: number;
  spec_rev: number;
  thread_id: string;
  turn_id: string | null;
  workspace: string;
  base_commit: string;
  reclaimed: boolean;
}

export interface A2AVerification {
  verification_id: string;
  attempt: A2AAttempt;
  spec_rev: number;
  G: string;
  C: string;
  M: string;
  oracle: string;
  workspace: string;
  state: "running" | "passed" | "failed";
  result?: { argv: string[]; cwd: string; stdout: string; stderr: string; exit: number | null };
}

export interface A2ATask {
  task_id: string;
  project_id: string;
  repo: string;
  oracle: string;
  instructions: string;
  base_commit: string;
  state: string;
  spec_rev: number;
  fence: number;
  current_attempt: A2AAttempt | null;
  candidate_commit: string | null;
  verification: A2AVerification | null;
  integration_intent: { G: string; M: string; verification_id: string; attempt: A2AAttempt; state: "pending" | "completed" } | null;
}

export interface A2AGateResult {
  ok: boolean;
  task?: A2ATask;
  error?: string;
  details?: unknown;
  events?: ReadonlyArray<{ seq: number; time: string; type: string; details: unknown }>;
}
