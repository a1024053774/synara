import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { CommandId, ProjectId } from "@synara/contracts";
import { Effect, Layer, ManagedRuntime } from "effect";
import { it } from "vitest";
import { ServerConfig } from "../config";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite";
import { ServerSettingsService } from "../serverSettings";
import { OrchestrationLayerLive } from "../orchestration/runtimeLayer";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery";
import { ProviderService } from "../provider/Services/ProviderService";
import { ProviderRuntimeIngestionService } from "../orchestration/Services/ProviderRuntimeIngestion";
import { ProviderCommandReactor } from "../orchestration/Services/ProviderCommandReactor";
import { A2AGateService, A2AGateServiceLive } from "./service";

// Failures to cover: constant project title, task title used as project title,
// an existing project renamed, and an existing project's repo mismatch accepted.
// The gate, native engine, SQLite projection and sidebar snapshot are real.
// Provider methods are unavailable: create must never start a model.
it("uses each create project id as its sidebar title and preserves existing projects", async () => {
  const root = mkdtempSync(join(tmpdir(), "a2a-t048-title-"));
  const repo = join(root, "repo");
  mkdirSync(repo);
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", repo, ...args], {
      encoding: "utf8",
      env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  git("init");
  git("config", "user.name", "T-048 independent project oracle");
  git("config", "user.email", "fixture@example.invalid");
  writeFileSync(join(repo, "input.txt"), "Title probe; no provider.\n");
  git("add", "input.txt");
  git("commit", "-m", "Title fixture");
  const oracle = join(root, "oracle.py");
  const instructions = join(root, "instructions.txt");
  writeFileSync(oracle, "raise SystemExit(0)\n");
  writeFileSync(instructions, "No model permitted.\n");
  const native = OrchestrationLayerLive.pipe(
    Layer.provideMerge(SqlitePersistenceMemory),
    Layer.provideMerge(ServerConfig.layerTest(repo, join(root, "server"))),
    Layer.provideMerge(ServerSettingsService.layerTest()),
    Layer.provideMerge(NodeServices.layer),
  );
  const runtime = ManagedRuntime.make(
    A2AGateServiceLive.pipe(
      Layer.provideMerge(native),
      Layer.provide(Layer.succeed(ProviderService, {} as never)),
      Layer.provide(Layer.succeed(ProviderRuntimeIngestionService, {} as never)),
      Layer.provide(Layer.succeed(ProviderCommandReactor, {} as never)),
    ),
  );
  try {
    const gates = await runtime.runPromise(Effect.service(A2AGateService));
    const engine = await runtime.runPromise(Effect.service(OrchestrationEngineService));
    const query = await runtime.runPromise(Effect.service(ProjectionSnapshotQuery));
    const create = (task: string, project: string) =>
      gates.call({
        command: "create",
        task,
        title: "Task display title must not name the project",
        project,
        repo,
        base: git("rev-parse", "HEAD"),
        oracle,
        instructions,
      });
    const observed = [];
    for (const project of ["release-catalogue", "sentinel-project-731"]) {
      const result = await create(`task-${project}`, project);
      assert.equal(result.ok, true, JSON.stringify(result));
      const snapshot = await runtime.runPromise(query.getShellSnapshot());
      const row = snapshot.projects.find((p) => p.id === project);
      observed.push(row);
      assert.equal(row?.title, project);
      assert.equal(row?.workspaceRoot, repo);
    }
    await runtime.runPromise(
      engine.dispatch({
        type: "project.create",
        commandId: CommandId.makeUnsafe("t048-existing-project"),
        projectId: ProjectId.makeUnsafe("existing-project"),
        title: "用户原有项目名",
        workspaceRoot: repo,
        createdAt: "2026-10-09T00:00:00.000Z",
      }),
    );
    const before = (await runtime.runPromise(query.getShellSnapshot())).projects.find(
      (p) => p.id === "existing-project",
    );
    assert.equal((await create("task-existing", "existing-project")).ok, true);
    const after = (await runtime.runPromise(query.getShellSnapshot())).projects.find(
      (p) => p.id === "existing-project",
    );
    assert.deepEqual(after, before);
    await runtime.runPromise(
      engine.dispatch({
        type: "project.create",
        commandId: CommandId.makeUnsafe("t048-foreign-project"),
        projectId: ProjectId.makeUnsafe("foreign-project"),
        title: "另一个仓库",
        workspaceRoot: join(root, "foreign-repo"),
        createdAt: "2026-10-09T00:00:00.000Z",
      }),
    );
    const mismatch = await create("task-mismatch", "foreign-project");
    assert.equal(mismatch.ok, false);
    assert.match(JSON.stringify(mismatch), /project_repo_mismatch/);
    const proof = {
      status: "PASS",
      fixture_root: root,
      created: observed,
      existing: after,
      mismatch,
    };
    console.log(JSON.stringify(proof));
    if (process.env.A2A_TITLE_PROOF_PATH)
      writeFileSync(process.env.A2A_TITLE_PROOF_PATH, JSON.stringify(proof, null, 2) + "\n");
  } finally {
    await runtime.dispose();
  }
});
