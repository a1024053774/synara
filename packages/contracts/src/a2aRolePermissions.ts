import { Schema } from "effect";
import { A2ASessionPreset } from "./a2aInbox";
import { NonNegativeInt } from "./baseSchemas";

export const A2ACapability = Schema.Literals([
  "a2a:operate",
  "a2a:read",
  "a2a:inbox",
  "a2a:stop",
  "a2a:submit",
  "a2a:raise",
]);
export type A2ACapability = typeof A2ACapability.Type;
export const A2ARolePermissionSelection = Schema.Struct({
  capabilities: Schema.Array(A2ACapability),
  autoApproveTools: Schema.NullOr(Schema.Array(Schema.String)),
});
export type A2ARolePermissionSelection = typeof A2ARolePermissionSelection.Type;
export const A2ARolePermissionsRequest = Schema.Union([
  Schema.Struct({
    command: Schema.Literal("save"),
    role: A2ASessionPreset,
    revision: NonNegativeInt,
    selection: A2ARolePermissionSelection,
  }),
  Schema.Struct({
    command: Schema.Literal("reset"),
    role: A2ASessionPreset,
    revision: NonNegativeInt,
  }),
]);
export type A2ARolePermissionsRequest = typeof A2ARolePermissionsRequest.Type;
export interface A2ARolePermissionView {
  role: A2ASessionPreset;
  revision: number;
  custom: unknown;
  defaults: A2ARolePermissionSelection;
  effective: A2ARolePermissionSelection | null;
  error?: string;
}
export interface A2ARolePermissionChange {
  id: string;
  actor: string;
  created_at: string;
  role: A2ASessionPreset;
  command: "save" | "reset";
  revision: number;
  before: unknown;
  after: A2ARolePermissionSelection | null;
  input_id: string;
  text: string;
}
export interface A2ARolePermissionSettings {
  roles: ReadonlyArray<A2ARolePermissionView>;
  catalog: ReadonlyArray<{
    capability: A2ACapability;
    label: string;
    tools: ReadonlyArray<string>;
  }>;
  changes: ReadonlyArray<A2ARolePermissionChange>;
}
