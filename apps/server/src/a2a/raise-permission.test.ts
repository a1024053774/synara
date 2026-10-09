import { afterEach, describe, expect, it, vi } from "vitest";
import { ThreadId } from "@synara/contracts";
import { CodexAppServerManager } from "../codexAppServerManager";
import { isSynaraGatewayToolName } from "../agentGateway/computerToolPermission";

// Failure list, from ready_rev 2 and the existing native permission contract:
// missing catalog entry; absent grant; retired/missing lease; idle/stale turn;
// wrong native thread/server; stopping runtime; unrelated tool privilege.
// Only native I/O is controlled. The actual manager owns the approval decision.
function fixture(toolName = "a2a_raise") {
  const manager = new CodexAppServerManager();
  const context = {
    session: {
      provider: "codex",
      status: "running",
      threadId: ThreadId.makeUnsafe("managed-worker"),
      runtimeMode: "full-access",
      model: "gpt-6.1-sol",
      activeTurnId: "active-turn",
      resumeCursor: { threadId: "native-worker" },
      createdAt: "2026-10-09T00:00:00.000Z",
      updatedAt: "2026-10-09T00:00:00.000Z",
    },
    account: { type: "unknown", planType: null, sparkEnabled: true },
    pending: new Map(),
    pendingApprovals: new Map(),
    pendingUserInputs: new Map(),
    collabReceiverTurns: new Map<string, string>(),
    collabReceiverParents: new Map<string, string>(),
    reviewTurnIds: new Set<string>(),
    gatewayCredentialRetired: false,
    nextRequestId: 1,
    stopping: false,
    enableComputerControl: false,
    activeInteractionMode: "default",
    autoApproveSynaraTools: false,
    gatewaySessionLease: { release: vi.fn() } as { release: () => void } | undefined,
  };
  vi.spyOn(
    manager as unknown as { emitEvent: (...args: unknown[]) => void },
    "emitEvent",
  ).mockImplementation(() => {});
  vi.spyOn(
    manager as unknown as { updateSession: (...args: unknown[]) => void },
    "updateSession",
  ).mockImplementation(() => {});
  vi.spyOn(
    manager as unknown as { requireSession: (id: ThreadId) => unknown },
    "requireSession",
  ).mockReturnValue(context);
  const write = vi
    .spyOn(
      manager as unknown as { writeMessage: (...args: unknown[]) => Promise<void> },
      "writeMessage",
    )
    .mockResolvedValue(undefined);
  const params = {
    threadId: "native-worker",
    turnId: "active-turn",
    serverName: "synara",
    mode: "form",
    message: `Allow the synara MCP server to run tool "${toolName}"?`,
    requestedSchema: { type: "object", properties: {} },
    _meta: {
      codex_approval_kind: "mcp_tool_call",
      persist: ["session"],
      tool_name: toolName,
      tool_params: { title: "independent sentinel" },
    },
  };
  const invoke = () =>
    (
      manager as unknown as {
        handleServerRequest: (context: unknown, request: unknown) => Promise<void>;
      }
    ).handleServerRequest(context, {
      id: 19,
      method: "mcpServer/elicitation/request",
      params,
    });
  return { context, params, write, invoke };
}
afterEach(() => vi.restoreAllMocks());

describe("a2a_raise native approval contract", () => {
  it("accepts an active full-access worker call once without persistence", async () => {
    const f = fixture();
    await f.invoke();
    expect(f.write).toHaveBeenCalledWith(f.context, {
      id: 19,
      result: { action: "accept", content: null, _meta: null },
    });
    expect(f.context.pendingApprovals.size).toBe(0);
  });
  it("accepts an active call with an explicit coordinator grant", async () => {
    const f = fixture();
    f.context.session.runtimeMode = "approval-required";
    f.context.autoApproveSynaraTools = true;
    await f.invoke();
    expect(f.write).toHaveBeenCalledTimes(1);
    expect(f.context.pendingApprovals.size).toBe(0);
  });
  it.each([
    "ungranted",
    "no-lease",
    "retired",
    "inactive",
    "stale-turn",
    "wrong-thread",
    "wrong-server",
    "stopping",
    "unrelated-tool",
  ])("preserves the interactive permission path for %s", async (condition) => {
    const f = fixture();
    switch (condition) {
      case "ungranted":
        f.context.session.runtimeMode = "approval-required";
        break;
      case "no-lease":
        f.context.gatewaySessionLease = undefined;
        break;
      case "retired":
        f.context.gatewayCredentialRetired = true;
        break;
      case "inactive":
        f.context.session.status = "ready";
        break;
      case "stale-turn":
        f.params.turnId = "old-turn";
        break;
      case "wrong-thread":
        f.params.threadId = "other-thread";
        break;
      case "wrong-server":
        f.params.serverName = "other-server";
        break;
      case "stopping":
        f.context.stopping = true;
        break;
      case "unrelated-tool":
        f.params._meta.tool_name = "shell";
        break;
    }
    await f.invoke();
    expect(f.write).not.toHaveBeenCalled();
    expect(f.context.pendingApprovals.size).toBe(1);
  });
  it("registers exactly the gateway names and retains a2a_submit", () => {
    expect(isSynaraGatewayToolName("mcp__synara__a2a_raise")).toBe(true);
    expect(isSynaraGatewayToolName("mcp__synara__a2a_submit")).toBe(true);
    expect(isSynaraGatewayToolName("mcp__other__a2a_raise")).toBe(false);
    expect(isSynaraGatewayToolName("mcp__synara__a2a_raise_extra")).toBe(false);
  });
});

// T-061 failure list: digit names rejected; absent/stale identity or grant
// accepted; unknown digit names accepted; prose or metadata precedence widened.
describe("a2a digit names without native tool_name", () => {
  it.each([
    ["a2a_raise", "full-access", false],
    ["a2a_submit", "full-access", false],
    ["a2a_raise", "approval-required", true],
    ["a2a_submit", "approval-required", true],
  ] as const)(
    "accepts %s in %s with coordinator grant=%s once without persistence",
    async (toolName, runtimeMode, grant) => {
      const f = fixture(toolName);
      Reflect.deleteProperty(f.params._meta, "tool_name");
      f.context.session.runtimeMode = runtimeMode;
      f.context.autoApproveSynaraTools = grant;
      await f.invoke();
      expect(f.write).toHaveBeenCalledExactlyOnceWith(f.context, {
        id: 19,
        result: { action: "accept", content: null, _meta: null },
      });
      expect(f.context.pendingApprovals.size).toBe(0);
    },
  );

  const conditions = [
    "ungranted",
    "no-lease",
    "retired",
    "inactive",
    "no-turn",
    "stale-turn",
    "wrong-thread",
    "wrong-server",
    "wrong-kind",
    "stopping",
    "plan",
    "unrelated-tool",
    "unrelated-digit-tool",
  ];
  it.each(
    ["a2a_raise", "a2a_submit"].flatMap((tool) => conditions.map((condition) => [tool, condition])),
  )("keeps %s interactive without tool_name for %s", async (toolName, condition) => {
    const f = fixture(toolName);
    Reflect.deleteProperty(f.params._meta, "tool_name");
    switch (condition) {
      case "ungranted":
        f.context.session.runtimeMode = "approval-required";
        break;
      case "no-lease":
        f.context.gatewaySessionLease = undefined;
        break;
      case "retired":
        f.context.gatewayCredentialRetired = true;
        break;
      case "inactive":
        f.context.session.status = "ready";
        break;
      case "no-turn":
        Reflect.deleteProperty(f.params, "turnId");
        break;
      case "stale-turn":
        f.params.turnId = "old-turn";
        break;
      case "wrong-thread":
        f.params.threadId = "other-thread";
        break;
      case "wrong-server":
        f.params.serverName = "other-server";
        break;
      case "wrong-kind":
        f.params._meta.codex_approval_kind = "other-kind";
        break;
      case "stopping":
        f.context.stopping = true;
        break;
      case "plan":
        f.context.activeInteractionMode = "plan";
        break;
      case "unrelated-tool":
        f.params.message = 'Allow the synara MCP server to run tool "shell"?';
        break;
      case "unrelated-digit-tool":
        f.params.message = 'Allow the synara MCP server to run tool "a2a_raise2"?';
        break;
    }
    await f.invoke();
    if (condition === "wrong-kind") {
      expect(f.write).toHaveBeenCalledExactlyOnceWith(f.context, {
        id: 19,
        result: { action: "cancel", content: null, _meta: null },
      });
    } else {
      expect(f.write).not.toHaveBeenCalled();
      expect(f.context.pendingApprovals.size).toBe(1);
    }
  });

  it.each([
    "Please approve a2a_raise",
    'Allow the synara MCP server to run tool "a2a_raise"? Extra text',
    'Allow the other MCP server to run tool "a2a_raise"?',
    'Allow the synara MCP server to run tool "a2a_raise_extra"?',
    'Allow the synara MCP server to run tool "a2a_submit2"?',
  ])("keeps noncanonical or unlisted prompt interactive: %s", async (message) => {
    const f = fixture();
    Reflect.deleteProperty(f.params._meta, "tool_name");
    f.params.message = message;
    await f.invoke();
    expect(f.write).not.toHaveBeenCalled();
    expect(f.context.pendingApprovals.size).toBe(1);
  });

  it("keeps explicit tool_name authoritative over a known prompt", async () => {
    const f = fixture();
    f.params._meta.tool_name = "shell2";
    await f.invoke();
    expect(f.write).not.toHaveBeenCalled();
    expect(f.context.pendingApprovals.size).toBe(1);
  });
});
