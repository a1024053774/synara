import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, Layer, ManagedRuntime } from "effect";
import { it, vi } from "vitest";
import { ServerConfig } from "../config";
import { makeServerProviderLayer, makeServerRuntimeServicesLayer } from "../serverLayers";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite";
import { ServerSettingsService } from "../serverSettings";
import { ProviderRuntimeIngestionService } from "../orchestration/Services/ProviderRuntimeIngestion";
import { ProviderCommandReactor } from "../orchestration/Services/ProviderCommandReactor";
import { OrchestrationReactor } from "../orchestration/Services/OrchestrationReactor";
import { A2AGateService } from "./service";

const observed = vi.hoisted(() => ({
  ingestion: [] as string[],
  command: [] as string[],
  starts: [] as string[],
  drains: [] as string[],
}));

// Replace only the two producer factories with distinct construction tokens.
// Build the actual production composition and exercise its original consumers.
vi.mock("../orchestration/Layers/ProviderRuntimeIngestion", async () => {
  const { Effect, Layer } = await import("effect");
  const { ProviderRuntimeIngestionService } =
    await import("../orchestration/Services/ProviderRuntimeIngestion");
  return {
    ProviderRuntimeIngestionLive: Layer.effect(
      ProviderRuntimeIngestionService,
      Effect.sync(() => {
        const id = `ingestion-${observed.ingestion.length + 1}`;
        observed.ingestion.push(id);
        return {
          start: Effect.sync(() => {
            observed.starts.push(id);
          }),
          drain: Effect.sync(() => {
            observed.drains.push(id);
          }),
          reconcileSettledOpenTurns: Effect.void,
        };
      }),
    ),
  };
});

vi.mock("../orchestration/Layers/ProviderCommandReactor", async () => {
  const { Effect, Layer } = await import("effect");
  const { ProviderCommandReactor } =
    await import("../orchestration/Services/ProviderCommandReactor");
  return {
    ProviderCommandReactorLive: Layer.effect(
      ProviderCommandReactor,
      Effect.sync(() => {
        const id = `command-${observed.command.length + 1}`;
        observed.command.push(id);
        return {
          start: Effect.sync(() => {
            observed.starts.push(id);
          }),
          drain: Effect.sync(() => {
            observed.drains.push(id);
          }),
          listBlockingDeliveries: () => Effect.succeed([]),
          reconcileDelivery: () => Effect.succeed(null),
          regenerateThreadTitle: () =>
            Effect.die("No model is permitted in this composition probe"),
        };
      }),
    ),
  };
});

it("shares one producer instance between the production reactor and a2a gate", async () => {
  const root = mkdtempSync(join(tmpdir(), "a2a-t039-sharing-"));
  const repo = join(root, "repo");
  mkdirSync(repo);
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", repo, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
    }).trim();
  git("init");
  git("config", "user.name", "Independent shared-layer probe");
  git("config", "user.email", "fixture@example.invalid");
  writeFileSync(join(repo, "input.txt"), "Independent original\n");
  git("add", "input.txt");
  git("commit", "-m", "Independent original");
  const oracle = join(root, "oracle.py"),
    instructions = join(root, "instructions.txt");
  writeFileSync(oracle, "raise SystemExit(0)\n");
  writeFileSync(instructions, "No native model start.\n");
  const config = ServerConfig.layerTest(repo, join(root, "server"), {
    homeDir: root,
    chatWorkspaceRoot: root,
    studioWorkspaceRoot: root,
    groupsWorkspaceRoot: root,
  }).pipe(Layer.provide(NodeServices.layer));
  const production = Layer.empty.pipe(
    Layer.provideMerge(makeServerRuntimeServicesLayer()),
    Layer.provideMerge(makeServerProviderLayer()),
    Layer.provideMerge(SqlitePersistenceMemory),
    Layer.provideMerge(config),
    Layer.provideMerge(NodeServices.layer),
    Layer.provideMerge(ServerSettingsService.layerTest()),
  );
  const runtime = ManagedRuntime.make(production);
  try {
    const ingestion = await runtime.runPromise(Effect.service(ProviderRuntimeIngestionService));
    const command = await runtime.runPromise(Effect.service(ProviderCommandReactor));
    const reactor = await runtime.runPromise(Effect.service(OrchestrationReactor));
    await runtime.runPromise(Effect.scoped(reactor.start));
    assert.deepEqual(observed.ingestion, ["ingestion-1"]);
    assert.deepEqual(observed.command, ["command-1"]);
    assert.equal(observed.starts.filter((x) => x === "ingestion-1").length, 1);
    assert.equal(observed.starts.filter((x) => x === "command-1").length, 1);
    const gates = await runtime.runPromise(Effect.service(A2AGateService));
    assert.equal(
      (
        await gates.call({
          command: "create",
          task: "shared",
          project: "shared-project",
          repo,
          base: git("rev-parse", "HEAD"),
          oracle,
          instructions,
        })
      ).ok,
      true,
    );
    const dispatch = await gates.call({
      command: "dispatch",
      task: "shared",
      runtimeMode: "full-access",
    });
    assert.equal(dispatch.ok, true, JSON.stringify(dispatch));
    const reclaimed = await gates.call({
      command: "reclaim",
      task: "shared",
      attempt: dispatch.attempt!.attempt_id,
    });
    assert.equal(reclaimed.ok, false); // The controlled producer never applies the stop intent.
    assert.ok(observed.drains.includes("ingestion-1"));
    assert.ok(observed.drains.includes("command-1"));
    assert.deepEqual(observed.ingestion, ["ingestion-1"]);
    assert.deepEqual(observed.command, ["command-1"]);
    assert.equal(
      await runtime.runPromise(Effect.service(ProviderRuntimeIngestionService)),
      ingestion,
    );
    assert.equal(await runtime.runPromise(Effect.service(ProviderCommandReactor)), command);
    const proof = {
      status: "PASS",
      fixture_root: root,
      constructors: {
        ingestion: observed.ingestion,
        command: observed.command,
      },
      starts: observed.starts,
      gate_drains: observed.drains,
      real_models: 0,
      scope: "Actual serverLayers composition; only producer factories controlled",
    };
    console.log(JSON.stringify(proof));
    if (process.env.A2A_SHARING_PROOF_PATH)
      writeFileSync(process.env.A2A_SHARING_PROOF_PATH, JSON.stringify(proof, null, 2) + "\n");
  } finally {
    await runtime.dispose();
  }
});
