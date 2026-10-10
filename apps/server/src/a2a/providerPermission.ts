import { a2aPermissionCatalog } from "@synara/a2a-gates/rolePermissions";
import type { AgentGatewaySessionIdentity } from "../agentGateway/Services/AgentGatewaySessionRegistry";

const tools = new Set(a2aPermissionCatalog.flatMap((row) => row.tools));
/** Match owned tool identities, never permission prose or display titles. */
export function a2aProviderToolName(value: unknown, serverPinned = false): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  if (!serverPinned && !normalized.startsWith("mcp__synara__") && !normalized.startsWith("synara_"))
    return undefined;
  const name = normalized.startsWith("mcp__synara__")
    ? normalized.slice(13)
    : normalized.startsWith("synara_")
      ? normalized.slice(7)
      : normalized;
  return tools.has(name) ? name : undefined;
}
/** Undefined delegates a non-a2a tool or an uncustomized role to the existing policy. */
export function a2aProviderPermission(input: {
  name: unknown;
  serverPinned?: boolean;
  permissions: AgentGatewaySessionIdentity["a2aPermissions"] | null;
  activeTurn: boolean;
  interactionMode: string | undefined;
}): "allow" | "prompt" | undefined {
  const name = a2aProviderToolName(input.name, input.serverPinned);
  if (!name) return undefined;
  if (!input.permissions || !input.activeTurn || input.interactionMode !== "default")
    return "prompt";
  if (input.permissions.autoApproveTools === null) return undefined;
  return input.permissions.autoApproveTools.includes(name) ? "allow" : "prompt";
}
