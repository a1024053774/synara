import assert from "node:assert/strict";
import { it } from "vitest";
import type { A2ASessionPreset } from "@synara/contracts";
import { makeAgentGatewaySessionRegistry } from "../agentGateway/Layers/AgentGatewaySessionRegistry";
import { filterToolsByCapability } from "../agentGateway/toolRuntime";
import { a2aControllerTools, a2aSubmitTool, a2aRaiseTool, a2aDispositionTool } from "./tools";

// Expected catalog names come from spec sections 1/4/5 and T-058.
const expected = {
  worker: ["a2a_raise", "a2a_submit"],
  reviewer: ["a2a_raise"],
  monitor: ["a2a_raise"],
  ideation: [
    "a2a_disposition",
    "a2a_events",
    "a2a_inbox_ack",
    "a2a_inbox_list",
    "a2a_inbox_send",
    "a2a_issues",
    "a2a_status",
    "a2a_stop",
  ],
  executor: [
    "a2a_attach",
    "a2a_claim",
    "a2a_create",
    "a2a_dispatch",
    "a2a_disposition",
    "a2a_events",
    "a2a_inbox_ack",
    "a2a_inbox_list",
    "a2a_inbox_send",
    "a2a_integrate",
    "a2a_issues",
    "a2a_reclaim",
    "a2a_revise",
    "a2a_revoke",
    "a2a_run",
    "a2a_status",
    "a2a_verify",
  ],
};
const tools = [
  a2aSubmitTool(null as never),
  a2aRaiseTool(null as never),
  a2aDispositionTool(null as never),
  ...a2aControllerTools(null as never),
];
it("issues the exact role catalog and keeps ordinary Synara capabilities unchanged", () => {
  let preset: A2ASessionPreset | undefined;
  const registry = makeAgentGatewaySessionRegistry({ a2aPresetForThread: () => preset });
  for (const role of ["worker", "reviewer", "monitor", "ideation", "executor"] as const) {
    preset = role;
    const credential = registry.issue("preset-thread" as never, "codex", {
      additionalCapabilities: ["computer:control"],
    });
    assert.deepEqual(
      filterToolsByCapability(tools, credential.capabilities)
        .map((entry) => entry.definition.name)
        .sort(),
      expected[role],
    );
    assert.equal(credential.capabilities.has("thread:write"), false);
    assert.equal(credential.capabilities.has("computer:control"), false);
  }
  preset = undefined;
  const ordinary = registry.issue("ordinary-thread" as never, "codex");
  assert.deepEqual([...ordinary.capabilities].sort(), [
    "automation:write",
    "browser:control",
    "device:control",
    "diagnostics:read",
    "thread:read",
    "thread:write",
  ]);
});
it("freezes existing credentials when the selected preset changes", () => {
  let preset: A2ASessionPreset = "worker";
  const registry = makeAgentGatewaySessionRegistry({ a2aPresetForThread: () => preset });
  const old = registry.issue("same-thread" as never, "codex");
  preset = "executor";
  assert.deepEqual([...registry.verify(old.token)!.capabilities].sort(), [
    "a2a:raise",
    "a2a:submit",
  ]);
  const fresh = registry.issue("same-thread" as never, "codex");
  assert.deepEqual([...fresh.capabilities].sort(), ["a2a:inbox", "a2a:operate", "a2a:read"]);
});
