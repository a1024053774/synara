import type { A2ASessionPreset } from "@synara/contracts";
import type { AgentGatewayCapability } from "../agentGateway/Services/AgentGatewaySessionRegistry";

// operate includes read authority, so status/events use the same tool names.
// inbox includes controller dispositions already defined by the issue contract.
export const a2aCapabilities: Readonly<
  Record<A2ASessionPreset, readonly AgentGatewayCapability[]>
> = {
  executor: ["a2a:operate", "a2a:read", "a2a:inbox"],
  ideation: ["a2a:read", "a2a:inbox", "a2a:stop"],
  worker: ["a2a:submit", "a2a:raise"],
  reviewer: ["a2a:raise"],
  monitor: ["a2a:raise"],
};
