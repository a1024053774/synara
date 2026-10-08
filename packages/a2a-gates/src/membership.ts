import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { A2ATaskMembership } from "@synara/contracts";

export class MembershipRefusal extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

/** Display grouping only. Gate state and attempt authority stay in A2AGates. */
export class A2AMembership {
  private readonly db: DatabaseSync;

  constructor(root: string) {
    mkdirSync(root, { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(join(root, "membership.sqlite3"));
    this.db.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS memberships (id TEXT PRIMARY KEY, data TEXT NOT NULL)`);
  }

  close() {
    this.db.close();
  }

  list(project?: string): ReadonlyArray<A2ATaskMembership> {
    const tasks = this.db
      .prepare("SELECT data FROM memberships ORDER BY id")
      .all()
      .map((row) => JSON.parse(String(row.data)) as A2ATaskMembership);
    return project === undefined ? tasks : tasks.filter((task) => task.projectId === project);
  }

  save(input: A2ATaskMembership): A2ATaskMembership {
    if (new Set(input.members.map((member) => member.threadId)).size !== input.members.length)
      throw new MembershipRefusal("duplicate_member");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.db.prepare("SELECT data FROM memberships WHERE id=?").get(input.taskId);
      const current = row ? (JSON.parse(String(row.data)) as A2ATaskMembership) : null;
      if ((current?.revision ?? 0) !== input.revision)
        throw new MembershipRefusal("stale_revision");
      if (current && current.projectId !== input.projectId)
        throw new MembershipRefusal("task_project_mismatch");
      const task = { ...input, revision: input.revision + 1 };
      this.db
        .prepare(
          "INSERT INTO memberships(id,data) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data",
        )
        .run(task.taskId, JSON.stringify(task));
      this.db.exec("COMMIT");
      return task;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
}
