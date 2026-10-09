import { parseArgs } from "node:util";
import { A2AGateRequest } from "@synara/contracts";
import { Schema } from "effect";
import { A2AGates, Refusal, type GateRuntime } from "./core";

const commands: Record<string, { required: string[]; optional?: string[] }> = {
  create: { required: ["repo", "base", "oracle", "instructions"], optional: ["project", "title"] },
  dispatch: { required: ["runtime-mode"] },
  attach: { required: ["role", "model-selection", "instructions", "runtime-mode"] },
  run: { required: ["runtime-mode", "wait-seconds"] },
  claim: { required: ["owner"] },
  revoke: { required: ["reason"] },
  revise: { required: ["spec-rev"] },
  submit: { required: ["attempt", "session", "fence", "spec-rev", "commit"] },
  verify: { required: [], optional: ["attempt"] },
  integrate: { required: [], optional: ["attempt"] },
  status: { required: [] },
  events: { required: [] },
  reclaim: { required: [], optional: ["attempt", "thread"] },
};

async function emit(result: unknown) {
  await new Promise<void>((resolve, reject) => {
    process.stdout.write(JSON.stringify(result) + "\n", (error) =>
      error ? reject(error) : resolve(),
    );
  });
}

export async function main(argv = process.argv.slice(2), runtime?: GateRuntime) {
  // The HTTP transport remains available for native thread lifecycle commands.
  if (argv[0] && !argv[0].startsWith("-")) {
    const [endpoint, json] = argv;
    if (!endpoint || !json || !process.env.A2A_GATE_BEARER || argv.length !== 2) {
      console.error(
        "usage: A2A_GATE_BEARER=<owner session> bun packages/a2a-gates/src/cli.ts <server URL> '<request JSON>'",
      );
      return 2;
    }
    const request = Schema.decodeUnknownSync(A2AGateRequest)(JSON.parse(json));
    const url = new URL("/api/a2a", endpoint);
    url.searchParams.set("token", process.env.A2A_GATE_BEARER);
    const response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.A2A_GATE_BEARER}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(request),
      // run owns its submit and phase deadlines. wait_seconds is not a total
      // runtime limit; Bun's idle timer must not discard its final receipt.
      ...(request.command === "run" ? { timeout: false } : {}),
    });
    const result = (await response.json()) as { ok?: boolean };
    await emit(result);
    return response.ok && result.ok ? 0 : 1;
  }
  let root: string;
  let request: Record<string, unknown>;
  try {
    const keys = [
      "state",
      "task",
      "repo",
      "project",
      "title",
      "thread",
      "role",
      "model-selection",
      "runtime-mode",
      "wait-seconds",
      "base",
      "oracle",
      "instructions",
      "owner",
      "reason",
      "attempt",
      "session",
      "fence",
      "spec-rev",
      "commit",
    ];
    const { values, positionals } = parseArgs({
      args: argv,
      options: Object.fromEntries(keys.map((key) => [key, { type: "string" as const }])),
      allowPositionals: true,
    });
    const command = positionals[0] ?? "";
    const contract = commands[command];
    if (!contract || positionals.length !== 1 || !values.state || !values.task)
      throw new Error("state, command and task required");
    const allowed = ["state", "task", ...contract.required, ...(contract.optional ?? [])];
    if (
      Object.keys(values).some((key) => !allowed.includes(key)) ||
      contract.required.some((key) => values[key] === undefined)
    )
      throw new Error("invalid command arguments");
    root = values.state;
    request = { command };
    for (const [key, value] of Object.entries(values)) {
      if (key === "state") continue;
      if (key === "fence" || key === "spec-rev" || key === "wait-seconds") {
        if (
          typeof value !== "string" ||
          !/^[+-]?\d+$/.test(value) ||
          !Number.isSafeInteger(Number(value))
        )
          throw new Error("integer required: " + key);
        request[key.replaceAll("-", "_")] = Number(value);
      } else if (key === "model-selection") request.modelSelection = JSON.parse(value!);
      else request[key === "runtime-mode" ? "runtimeMode" : key] = value;
    }
  } catch (error) {
    console.error("usage: --state ABS_DIR COMMAND --task ID ...\n" + String(error));
    return 2;
  }
  let gates: A2AGates;
  try {
    gates = new A2AGates(root, runtime);
  } catch (error) {
    await emit({
      ok: false,
      error: error instanceof Refusal ? error.code : "local_io_failed",
      details: String(error),
    });
    return 1;
  }
  try {
    const result = await gates.call(request);
    await emit(result);
    return result.ok ? 0 : 1;
  } finally {
    gates.close();
  }
}
if (import.meta.main) process.exitCode = await main();
