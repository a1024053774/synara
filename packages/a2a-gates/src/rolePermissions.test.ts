import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { A2AGates } from "./core";

// Failure list: stale window overwrites; records split across commits; wrong
// defaults; unknown persisted capability silently falls back; empty set
// rejected; reset removes audit history; incomplete transaction survives.
it("uses the hand-written five role defaults and atomic CAS saves and reset", () => {
  const root = mkdtempSync(join(tmpdir(), "t064-domain-"));
  const gates = new A2AGates(root);
  const db = new DatabaseSync(join(root, "state.sqlite3"));
  try {
    expect(
      gates.rolePermissionSettings().roles.map((row) => [row.role, row.effective!.capabilities]),
    ).toEqual([
      ["executor", ["a2a:operate", "a2a:read", "a2a:inbox"]],
      ["ideation", ["a2a:read", "a2a:inbox", "a2a:stop"]],
      ["worker", ["a2a:submit", "a2a:raise"]],
      ["reviewer", ["a2a:raise"]],
      ["monitor", ["a2a:raise"]],
    ]);
    gates.saveRolePermissionSettings({
      command: "save",
      role: "worker",
      revision: 0,
      selection: { capabilities: [], autoApproveTools: [] },
    });
    expect(() =>
      gates.saveRolePermissionSettings({ command: "reset", role: "worker", revision: 0 }),
    ).toThrow("stale_revision");
    expect(
      gates.rolePermissionSettings().roles.find((row) => row.role === "worker")!.effective!
        .capabilities,
    ).toEqual([]);
    gates.saveRolePermissionSettings({ command: "reset", role: "worker", revision: 1 });
    const changes = gates.rolePermissionSettings().changes;
    expect(changes.map((row) => row.command)).toEqual(["reset", "save"]);
    const inputs = db
      .prepare("SELECT data FROM user_inputs ORDER BY rowid")
      .all()
      .map((row) => JSON.parse(String(row.data)));
    expect(inputs.map((row) => [row.form, row.channel, row.content.command])).toEqual([
      ["action", "settings-page", "save"],
      ["action", "settings-page", "reset"],
    ]);
    expect(
      inputs.every((row) =>
        changes.some((change) => change.input_id === row.id && change.text === row.text),
      ),
    ).toBe(true);
    expect(() => db.exec("DELETE FROM role_permission_changes")).toThrow("append only");
    expect(
      gates.rolePermissionSettings().roles.find((row) => row.role === "worker")!.custom,
    ).toBeNull();
    db.exec(
      "CREATE TRIGGER t064_fail_input BEFORE INSERT ON user_inputs BEGIN SELECT RAISE(ABORT,'injected input failure'); END",
    );
    expect(() =>
      gates.saveRolePermissionSettings({
        command: "save",
        role: "worker",
        revision: 2,
        selection: { capabilities: [], autoApproveTools: [] },
      }),
    ).toThrow("injected input failure");
    expect(gates.rolePermissionSettings().changes).toEqual(changes);
    expect(
      gates.rolePermissionSettings().roles.find((row) => row.role === "worker")!.revision,
    ).toBe(2);
  } finally {
    db.close();
    gates.close();
  }
});
it("rejects unknown saved capability names, preserves them and permits a CAS reset", () => {
  const root = mkdtempSync(join(tmpdir(), "t064-invalid-"));
  const gates = new A2AGates(root);
  const db = new DatabaseSync(join(root, "state.sqlite3"));
  try {
    db.prepare("INSERT INTO role_permissions(role,revision,data) VALUES (?,?,?)").run(
      "monitor",
      7,
      JSON.stringify({ capabilities: ["a2a:removed"], autoApproveTools: [] }),
    );
    const view = gates.rolePermissionSettings().roles.find((row) => row.role === "monitor")!;
    expect(view.effective).toBeNull();
    expect(view.error).toBe("invalid_saved_permissions");
    expect(view.custom).toEqual({ capabilities: ["a2a:removed"], autoApproveTools: [] });
    gates.saveRolePermissionSettings({ command: "reset", role: "monitor", revision: 7 });
    expect(gates.rolePermissionSettings().changes[0]!.before).toEqual(view.custom);
  } finally {
    db.close();
    gates.close();
  }
});
