import { A2AGateRequest } from "@synara/contracts";
import { Schema } from "effect";
const [endpoint, json] = process.argv.slice(2);
if (!endpoint || !json || !process.env.A2A_GATE_BEARER) {
  console.error(
    "usage: A2A_GATE_BEARER=<owner session> bun packages/a2a-gates/src/cli.ts <server URL> '<request JSON>'",
  );
  process.exit(2);
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
});
const result = (await response.json()) as { ok?: boolean };
console.log(JSON.stringify(result));
process.exit(response.ok && result.ok ? 0 : 1);
