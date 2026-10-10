import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { Schema } from "effect";
import {
  A2ARolePermissionSelection,
  type A2ACapability,
  type A2ARolePermissionsRequest,
  type A2ARolePermissionChange,
  type A2ARolePermissionSettings,
  type A2ARolePermissionView,
  type A2ASessionPreset,
  type A2AUserInput,
} from "@synara/contracts";

export const a2aCapabilities: Readonly<Record<A2ASessionPreset, readonly A2ACapability[]>> = {
  executor: ["a2a:operate", "a2a:read", "a2a:inbox"],
  ideation: ["a2a:read", "a2a:inbox", "a2a:stop"],
  worker: ["a2a:submit", "a2a:raise"],
  reviewer: ["a2a:raise"],
  monitor: ["a2a:raise"],
};
export const a2aPermissionCatalog: A2ARolePermissionSettings["catalog"] = [
  {
    capability: "a2a:operate",
    label: "执行门禁",
    tools: [
      "a2a_create",
      "a2a_claim",
      "a2a_dispatch",
      "a2a_attach",
      "a2a_verify",
      "a2a_integrate",
      "a2a_reclaim",
      "a2a_run",
      "a2a_revoke",
      "a2a_revise",
    ],
  },
  {
    capability: "a2a:read",
    label: "读取门禁与问题",
    tools: ["a2a_status", "a2a_events", "a2a_issues"],
  },
  {
    capability: "a2a:inbox",
    label: "主控收件箱与问题处置",
    tools: ["a2a_inbox_send", "a2a_inbox_list", "a2a_inbox_ack", "a2a_disposition"],
  },
  { capability: "a2a:stop", label: "紧急中断", tools: ["a2a_stop"] },
  { capability: "a2a:submit", label: "提交交付", tools: ["a2a_submit"] },
  { capability: "a2a:raise", label: "上报问题", tools: ["a2a_raise"] },
];

export class RolePermissionRefusal extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}
export function ensureRolePermissionTables(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS role_permissions (role TEXT PRIMARY KEY, revision INTEGER NOT NULL, data TEXT);
    CREATE TABLE IF NOT EXISTS role_permission_changes (seq INTEGER PRIMARY KEY AUTOINCREMENT, data TEXT NOT NULL);
    CREATE TRIGGER IF NOT EXISTS role_permission_changes_no_update BEFORE UPDATE ON role_permission_changes BEGIN SELECT RAISE(ABORT,'append only'); END;
    CREATE TRIGGER IF NOT EXISTS role_permission_changes_no_delete BEFORE DELETE ON role_permission_changes BEGIN SELECT RAISE(ABORT,'append only'); END;`);
}
function validateSelection(value: unknown): A2ARolePermissionSelection {
  const selection = Schema.decodeUnknownSync(A2ARolePermissionSelection)(value);
  const tools = a2aPermissionCatalog
    .filter((row) => selection.capabilities.includes(row.capability))
    .flatMap((row) => row.tools);
  if (
    new Set(selection.capabilities).size !== selection.capabilities.length ||
    (selection.autoApproveTools !== null &&
      (new Set(selection.autoApproveTools).size !== selection.autoApproveTools.length ||
        selection.autoApproveTools.some((name) => !tools.includes(name))))
  ) {
    throw new RolePermissionRefusal("invalid_permission_selection");
  }
  return selection;
}
export function readRolePermission(
  db: DatabaseSync,
  role: A2ASessionPreset,
): A2ARolePermissionView {
  const row = db.prepare("SELECT revision,data FROM role_permissions WHERE role=?").get(role);
  const defaults = { capabilities: [...a2aCapabilities[role]], autoApproveTools: null };
  const base = { role, revision: row ? Number(row.revision) : 0, defaults };
  if (!row || row.data === null) return { ...base, custom: null, effective: defaults };
  let custom: unknown = String(row.data);
  try {
    custom = JSON.parse(String(row.data));
    return { ...base, custom, effective: validateSelection(custom) };
  } catch {
    // Preserve the anomalous row and its revision. Issuance rejects it, and
    // the owner can inspect it and restore defaults through the same CAS path.
    return { ...base, custom, effective: null, error: "invalid_saved_permissions" };
  }
}
export function readRolePermissionSettings(db: DatabaseSync): A2ARolePermissionSettings {
  return {
    roles: (["executor", "ideation", "worker", "reviewer", "monitor"] as const).map((role) =>
      readRolePermission(db, role),
    ),
    catalog: a2aPermissionCatalog,
    changes: db
      .prepare("SELECT data FROM role_permission_changes ORDER BY seq DESC LIMIT 50")
      .all()
      .map((row) => JSON.parse(String(row.data)) as A2ARolePermissionChange),
  };
}
export function saveRolePermission(
  db: DatabaseSync,
  request: A2ARolePermissionsRequest,
  saveInput: (input: A2AUserInput) => void,
  now: number,
): A2ARolePermissionSettings {
  const after = request.command === "reset" ? null : validateSelection(request.selection);
  db.exec("BEGIN IMMEDIATE");
  try {
    const before = readRolePermission(db, request.role);
    if (before.revision !== request.revision) throw new RolePermissionRefusal("stale_revision");
    const revision = before.revision + 1;
    const id = randomUUID();
    const inputId = randomUUID();
    const createdAt = new Date(now).toISOString();
    const text = `${request.command === "reset" ? "恢复默认" : "修改角色权限"}：${request.role}；${JSON.stringify(before.custom)} → ${JSON.stringify(after)}`;
    const change: A2ARolePermissionChange = {
      id,
      actor: "user",
      created_at: createdAt,
      role: request.role,
      command: request.command,
      revision,
      before: before.custom,
      after,
      input_id: inputId,
      text,
    };
    db.prepare(
      "INSERT INTO role_permissions(role,revision,data) VALUES (?,?,?) ON CONFLICT(role) DO UPDATE SET revision=excluded.revision,data=excluded.data",
    ).run(request.role, revision, after === null ? null : JSON.stringify(after));
    saveInput({
      id: inputId,
      schema: 1,
      form: "action",
      text,
      target: { task: null, attempt: null, thread: "", turn: null, message: null },
      channel: "settings-page",
      reply_to: null,
      source_ref: { command_id: id, rpc: "a2a.role-permissions" },
      certainty: "observed",
      created_at: createdAt,
      content: change,
    });
    db.prepare("INSERT INTO role_permission_changes(data) VALUES (?)").run(JSON.stringify(change));
    db.exec("COMMIT");
  } finally {
    if (db.isTransaction) db.exec("ROLLBACK");
  }
  return readRolePermissionSettings(db);
}
