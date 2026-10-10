import { it, expect, vi } from "vitest";
import { Effect } from "effect";
import { a2aControllerTools } from "./tools";

// Failure list: adding operate shadows an existing stop grant; projection
// changes the requested target/stop receipt or skips active-turn checks.
it.each([false, true])("keeps stop authority when operate is added=%s", async (operate) => {
  const call = vi.fn(async () => ({ ok: false, error: "unknown_inbox_entry" }));
  const tools = a2aControllerTools({ call } as never);
  const stop = tools.find((tool) => tool.definition.name === "a2a_stop")!;
  const capabilities = new Set([
    "a2a:read",
    "a2a:inbox",
    "a2a:stop",
    ...(operate ? ["a2a:operate"] : []),
  ]);
  await Effect.runPromise(
    stop.handler({ thread: "owned-worker", stop_id: "external-missing-sentinel" }, {
      callerThreadId: "ideation-session",
      callerTurnId: "active-turn",
      callerCapabilities: capabilities,
      assertCallerTurnActive: () => Effect.void,
    } as never),
  );
  expect(call).toHaveBeenCalledOnce();
  const [request, caller] = call.mock.calls[0]! as unknown as [
    Record<string, unknown>,
    { address: string; thread: string; turn: string; assertActive: () => Promise<void> },
  ];
  expect(request).toEqual({
    command: "stop",
    thread: "owned-worker",
    stop_id: "external-missing-sentinel",
  });
  expect(caller.address).toBe("ideation");
  expect(caller.thread).toBe("ideation-session");
  expect(caller.turn).toBe("active-turn");
  await caller.assertActive();
});
