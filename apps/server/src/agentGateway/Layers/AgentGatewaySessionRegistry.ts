import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { A2AMembership } from "@synara/a2a-gates/membership";
import type { A2ASessionPreset } from "@synara/contracts";

import { Effect, Layer } from "effect";
import { ServerConfig } from "../../config";
import { a2aCapabilities } from "../../a2a/capabilities";

import {
  AgentGatewaySessionRegistry,
  type AgentGatewayCapability,
  type AgentGatewaySessionIdentity,
  type AgentGatewaySessionRegistryShape,
  type AgentGatewayWriteAuthority,
} from "../Services/AgentGatewaySessionRegistry.ts";

const PROVIDER_SESSION_CAPABILITIES = [
  "thread:read",
  "thread:write",
  "automation:write",
  "diagnostics:read",
  "browser:control",
  "device:control",
] as const;

export function makeAgentGatewaySessionRegistry(options?: {
  readonly now?: () => number;
  readonly randomId?: () => string;
  readonly a2aPresetForThread?: (thread: string) => A2ASessionPreset | undefined;
}): AgentGatewaySessionRegistryShape {
  const now = options?.now ?? Date.now;
  const randomId = options?.randomId ?? randomUUID;
  interface RegisteredSession {
    identity: AgentGatewaySessionIdentity;
    retiredWriteTurnId: string | undefined;
  }
  const sessions = new Map<string, RegisteredSession>();
  const sessionsByKey = new Map<string, RegisteredSession>();

  const disabledComputerThreads = new Set<string>();
  const visibleIdentity = (identity: AgentGatewaySessionIdentity): AgentGatewaySessionIdentity =>
    disabledComputerThreads.has(identity.threadId)
      ? {
          ...identity,
          capabilities: new Set(
            [...identity.capabilities].filter((capability) => capability !== "computer:control"),
          ),
        }
      : identity;
  return {
    setComputerControlEnabled: (threadId, enabled) => {
      if (enabled) disabledComputerThreads.delete(threadId);
      else {
        disabledComputerThreads.add(threadId);
        for (const row of sessionsByKey.values()) {
          if (row.identity.threadId !== threadId) continue;
          row.identity = {
            ...row.identity,
            capabilities: new Set(
              [...row.identity.capabilities].filter(
                (capability) => capability !== "computer:control",
              ),
            ),
          };
        }
      }
    },
    computerControlProvisioned: (threadId, provider) => {
      const candidates = [...sessionsByKey.values()].filter(
        (row) => row.identity.threadId === threadId && row.identity.provider === provider,
      );
      return candidates.at(-1)?.identity.capabilities.has("computer:control") ?? false;
    },
    issue: (threadId, provider, issueOptions) => {
      // Every provider runtime owns an independent credential. Replacement
      // runtimes overlap their predecessor during startup, and the outgoing
      // runtime revokes its own token during teardown. Reusing a token here
      // would therefore let old-session cleanup invalidate the replacement.
      const issuedAt = now();
      const sessionKey = `gateway-session:${randomId()}`;
      const token = `sagw_session_${randomId()}`;
      const preset = options?.a2aPresetForThread?.(threadId);
      const identity: AgentGatewaySessionIdentity = {
        sessionKey,
        threadId,
        provider,
        issuedAt,
        capabilities: new Set<AgentGatewayCapability>([
          ...(preset ? a2aCapabilities[preset] : PROVIDER_SESSION_CAPABILITIES),
          ...(!preset ? (issueOptions?.additionalCapabilities ?? []) : []).filter(
            (capability) =>
              capability !== "computer:control" || !disabledComputerThreads.has(threadId),
          ),
        ]),
      };
      const registered: RegisteredSession = {
        identity,
        retiredWriteTurnId: undefined,
      };
      sessions.set(token, registered);
      sessionsByKey.set(sessionKey, registered);
      return { token, ...identity };
    },
    verify: (token) => {
      const identity = sessions.get(token)?.identity;
      return identity ? visibleIdentity(identity) : null;
    },
    bindWriteAuthority: (token, turnId) => {
      const registered = sessions.get(token);
      if (!registered || registered.retiredWriteTurnId !== undefined) return null;
      const { identity } = registered;
      return {
        sessionKey: identity.sessionKey,
        threadId: identity.threadId,
        provider: identity.provider,
        turnId,
      } satisfies AgentGatewayWriteAuthority;
    },
    verifyWriteAuthority: (authority) => {
      const registered = sessionsByKey.get(authority.sessionKey);
      const identity = registered?.identity;
      return (
        identity !== undefined &&
        registered?.retiredWriteTurnId === undefined &&
        identity.threadId === authority.threadId &&
        identity.provider === authority.provider
      );
    },
    retireWriteAuthority: (token, turnId) => {
      const registered = sessions.get(token);
      if (!registered) return false;
      if (registered.retiredWriteTurnId !== undefined) {
        return registered.retiredWriteTurnId === turnId;
      }
      // Record A even when it never called a gateway tool. This is the
      // critical case: a detached request from A must not arrive during B and
      // become the first request to bind this credential.
      registered.retiredWriteTurnId = turnId;
      return true;
    },
    revoke: (token) => {
      const registered = sessions.get(token);
      if (!registered) return;
      sessions.delete(token);
      sessionsByKey.delete(registered.identity.sessionKey);
    },
  };
}

export const AgentGatewaySessionRegistryLive = Layer.effect(
  AgentGatewaySessionRegistry,
  Effect.gen(function* () {
    const config = yield* ServerConfig;
    const bindings = new A2AMembership(join(config.stateDir, "a2a-gates"));
    yield* Effect.addFinalizer(() => Effect.sync(() => bindings.close()));
    return makeAgentGatewaySessionRegistry({
      a2aPresetForThread: (thread) => bindings.presetForThread(thread),
    });
  }),
);
