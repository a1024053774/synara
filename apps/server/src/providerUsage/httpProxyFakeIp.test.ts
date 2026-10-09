import { afterEach, expect, it, vi } from "vitest";

const { lookup, request } = vi.hoisted(() => ({
  lookup: vi.fn(),
  request: vi.fn((_url: URL, _options: unknown, _callback: unknown) => {
    throw new Error("Offline transport sentinel");
  }),
}));
vi.mock("node:dns/promises", () => ({ lookup }));
vi.mock("node:https", () => ({ request }));

import { outboundHttp } from "@synara/shared/outboundHttp";
import { fetchJson } from "./http";

// Failure modes: broad hostname opt-in, another reserved subnet, mixed DNS results,
// literal/mapped IPs, or bypassing the pinned transport/default outbound policy.
// The sentinel proves admission without opening a socket; rejection must precede it.
afterEach(() => {
  lookup.mockReset();
  request.mockClear();
});

function usage(url: string) {
  return fetchJson({ service: "fake-ip-test", url, allowedOrigins: [new URL(url).origin] });
}

it.each(["chatgpt.com", "api.anthropic.com", "api2.cursor.sh"])(
  "admits only the proxy subnet for the fixed usage host %s",
  async (host) => {
    for (const address of ["198.18.0.0", "198.18.0.79", "198.19.255.255"]) {
      lookup.mockResolvedValue([{ address, family: 4 }]);
      await expect(usage(`https://${host}/usage`)).rejects.toThrow("Offline transport sentinel");
    }
    expect(request).toHaveBeenCalledTimes(3);
    expect(request.mock.calls[0]?.[0]).toEqual(new URL(`https://${host}/usage`));
  },
);

it.each([
  "10.0.0.1",
  "172.16.0.1",
  "192.168.0.1",
  "127.0.0.1",
  "169.254.0.1",
  "198.17.255.255",
  "198.20.0.0",
  "::1",
  "fc00::1",
  "::ffff:198.18.0.79",
])("preserves the address policy for %s on each fixed usage host", async (address) => {
  for (const host of ["chatgpt.com", "api.anthropic.com", "api2.cursor.sh"]) {
    lookup.mockResolvedValue([{ address, family: address.includes(":") ? 6 : 4 }]);
    // 198.17/198.20 are outside the fake-IP subnet and public, so they reach transport.
    if (address.startsWith("198.17") || address.startsWith("198.20")) {
      await expect(usage(`https://${host}/usage`)).rejects.toThrow("Offline transport sentinel");
    } else {
      await expect(usage(`https://${host}/usage`)).rejects.toMatchObject({
        code: "private-address",
      });
      expect(request).not.toHaveBeenCalled();
    }
  }
});

it.each(["other.example", "chatgpt.com.other.example", "sub.chatgpt.com", "198.18.0.79"])(
  "rejects caller-supplied non-allowlisted host %s in the same subnet",
  async (host) => {
    lookup.mockResolvedValue([{ address: "198.18.0.79", family: 4 }]);
    await expect(usage(`https://${host}/usage`)).rejects.toMatchObject({ code: "private-address" });
    expect(request).not.toHaveBeenCalled();
  },
);

it("rejects a mixed DNS answer, alternate port, and a non-usage outbound request", async () => {
  lookup.mockResolvedValue([
    { address: "198.18.0.79", family: 4 },
    { address: "10.0.0.1", family: 4 },
  ]);
  await expect(usage("https://chatgpt.com/usage")).rejects.toMatchObject({
    code: "private-address",
  });
  lookup.mockResolvedValue([{ address: "198.18.0.79", family: 4 }]);
  await expect(usage("https://chatgpt.com:444/usage")).rejects.toMatchObject({
    code: "private-address",
  });
  await expect(
    outboundHttp.request({
      url: "https://chatgpt.com/usage",
      policy: {
        service: "other-outbound",
        allowedOrigins: ["https://chatgpt.com"],
        timeoutMs: 1000,
        maxRequestBytes: 0,
        maxResponseBytes: 1024,
        maxRedirects: 0,
        maxConcurrent: 1,
        maxQueued: 1,
        requirePublicAddress: true,
      },
    }),
  ).rejects.toMatchObject({ code: "private-address" });
  expect(request).not.toHaveBeenCalled();
});
