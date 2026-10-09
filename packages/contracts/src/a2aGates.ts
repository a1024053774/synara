import { Schema } from "effect";
import { ModelSelection } from "./orchestration";
import { A2AMemberRole } from "./a2aMembership";

export const A2AGateRequest = Schema.Struct({
  command: Schema.Literals([
    "create",
    "claim",
    "revoke",
    "revise",
    "dispatch",
    "attach",
    "run",
    "submit",
    "verify",
    "integrate",
    "reclaim",
    "status",
    "events",
  ]),
  task: Schema.String,
  repo: Schema.optional(Schema.String),
  project: Schema.optional(Schema.String),
  title: Schema.optional(Schema.String),
  thread: Schema.optional(Schema.String),
  role: Schema.optional(A2AMemberRole),
  modelSelection: Schema.optional(ModelSelection),
  base: Schema.optional(Schema.String),
  oracle: Schema.optional(Schema.String),
  instructions: Schema.optional(Schema.String),
  owner: Schema.optional(Schema.String),
  reason: Schema.optional(Schema.String),
  attempt: Schema.optional(Schema.String),
  session: Schema.optional(Schema.String),
  fence: Schema.optional(Schema.Number),
  spec_rev: Schema.optional(Schema.Number),
  commit: Schema.optional(Schema.String),
  wait_seconds: Schema.optional(Schema.Number),
  runtimeMode: Schema.optional(Schema.Literals(["approval-required", "full-access"])),
});
export type A2AGateRequest = typeof A2AGateRequest.Type;

export interface A2AAttempt {
  task_id: string;
  attempt_id: string;
  session_id: string;
  fence: number;
  spec_rev: number;
  thread_id: string;
  runtime_mode: "approval-required" | "full-access";
  turn_id: string | null;
  workspace: string;
  base_commit: string;
  reclaimed: boolean;
  reclaimed_at?: string;
  owner?: string;
  state?: string;
  revocation_reason?: string;
}

export interface A2ACommandResult {
  argv: string[];
  cwd: string;
  stdout: string | null;
  stderr: string | null;
  exit: number | null;
  returncode: number | null;
  outcome?: string;
}

export interface A2AVerification {
  verification_id: string;
  attempt: A2AAttempt;
  spec_rev: number;
  G: string;
  C: string;
  M: string | null;
  oracle: string;
  workspace: string;
  state: "running" | "passed" | "failed" | "interrupted" | "unknown" | "merge_failed";
  command_intent?: { argv: string[]; cwd: string };
  result?: A2ACommandResult;
  ended?: string;
}

export interface A2ATask {
  task_id: string;
  title?: string;
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
  integration_intent: {
    G: string;
    M: string;
    verification_id: string;
    attempt: A2AAttempt;
    spec_rev?: number;
    C?: string;
    oracle?: string;
    intent_id?: string;
    command_intent?: { argv: string[]; cwd: string };
    result?: A2ACommandResult;
    state: "pending" | "completed";
  } | null;
}

/** A normal native session with a display role, never a delivery attempt. */
export interface A2AAttachment {
  task_id: string;
  thread_id: string;
  role: typeof A2AMemberRole.Type;
  modelSelection: typeof ModelSelection.Type;
  runtime_mode: "approval-required" | "full-access";
  state: "creating" | "active" | "ended";
  ended_at?: string;
}

export interface A2ARun {
  run_id: string;
  task_id: string;
  attempt_id: string | null;
  thread_id: string | null;
  started: string;
  ended?: string;
  wait_seconds: number;
  phase: string;
  outcome: string;
  reclaimed?: boolean;
  error?: string;
  details?: unknown;
  cleanup_failure?: unknown;
}

export interface A2AHumanInputObserver {
  state: "starting" | "healthy" | "failed" | "stopped";
  updated_at: string;
  failure?: {
    event_id?: string;
    source_sequence?: number;
    thread_id?: string;
    message_id?: string;
    reason: string;
  };
}

export interface A2AGateResult {
  ok: boolean;
  task?: A2ATask;
  run?: A2ARun;
  human_input_observer?: A2AHumanInputObserver;
  attempt?: A2AAttempt;
  attachment?: A2AAttachment;
  verification?: A2AVerification;
  replayed?: boolean;
  reconciled?: boolean;
  error?: string;
  details?: unknown;
  events?: ReadonlyArray<{ seq: number; time: string; type: string; details: unknown }>;
}
