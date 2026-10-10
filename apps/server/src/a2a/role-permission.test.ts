import { describe, expect, it } from "vitest";
import { a2aProviderPermission } from "./providerPermission";
import { makeAgentGatewaySessionRegistry } from "../agentGateway/Layers/AgentGatewaySessionRegistry";

// Contract failure list: new settings ignored; an empty set falls back to a
// preset; old tokens change; exempt tool ignored/unchecked auto-approved;
// absent identity, idle/Plan turn, foreign server or display text admitted.
it("freezes customized capabilities and exemptions while preserving issued credentials", () => {
  let custom = false;
  const registry = makeAgentGatewaySessionRegistry({
    a2aPresetForThread: () => "worker",
    a2aPermissionForRole: () => ({
      role: "worker",
      revision: custom ? 1 : 0,
      custom: custom ? {} : null,
      defaults: { capabilities: ["a2a:submit", "a2a:raise"], autoApproveTools: null },
      effective: {
        capabilities: custom ? [] : ["a2a:submit", "a2a:raise"],
        autoApproveTools: custom ? [] : null,
      },
    }),
  });
  const old = registry.issue("worker-thread" as never, "codex");
  custom = true;
  const fresh = registry.issue("worker-thread" as never, "codex");
  expect([...registry.verify(old.token)!.capabilities]).toEqual(["a2a:submit", "a2a:raise"]);
  expect(registry.verify(old.token)!.a2aPermissions!.autoApproveTools).toBeNull();
  expect([...fresh.capabilities]).toEqual([]);
  expect(fresh.a2aPermissions!.autoApproveTools).toEqual([]);
});
describe("frozen a2a provider policy", () => {
  const base = {
    name: "mcp__synara__a2a_disposition",
    permissions: { role: "executor" as const, autoApproveTools: ["a2a_disposition"] },
    activeTurn: true,
    interactionMode: "default",
  };
  it("allows the checked disposition and prompts for an unchecked tool", () => {
    expect(a2aProviderPermission(base)).toBe("allow");
    expect(a2aProviderPermission({ ...base, name: "mcp__synara__a2a_claim" })).toBe("prompt");
    expect(
      a2aProviderPermission({ ...base, permissions: { role: "executor", autoApproveTools: [] } }),
    ).toBe("prompt");
  });
  it.each(["no-identity", "revoked", "idle", "plan"])("prompts for %s", (condition) => {
    expect(
      a2aProviderPermission({
        ...base,
        permissions:
          condition === "no-identity"
            ? undefined
            : condition === "revoked"
              ? null
              : base.permissions,
        activeTurn: condition !== "idle",
        interactionMode: condition === "plan" ? "plan" : "default",
      }),
    ).toBe("prompt");
  });
  it("keeps the existing policy for uncustomized roles and unrelated tools", () => {
    expect(
      a2aProviderPermission({ ...base, permissions: { role: "executor", autoApproveTools: null } }),
    ).toBeUndefined();
    for (const name of [
      "mcp__other__a2a_disposition",
      "mcp__synara__a2a_disposition_extra",
      "Please approve a2a_disposition",
      "shell",
    ]) {
      expect(a2aProviderPermission({ ...base, name })).toBeUndefined();
    }
  });
});
