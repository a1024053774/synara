import { A2AGateRequest } from "@synara/contracts";
import { Effect, Layer, Schema } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import { A2AGateService } from "./service";
import { ServerAuth } from "../auth/Services/ServerAuth";
import { makeEffectAuthRequest } from "../auth/effectHttp";
import { ServerConfig } from "../config";
import { shouldRejectUntrustedRequestOrigin, normalizeCorsOrigin } from "../trustedOrigins";
import { authenticateRpcWebSocketUpgrade } from "../wsRpc";
import { readMcpJsonBody } from "../agentGateway/httpRoute";
import { membershipRoute } from "./membershipRoute";

const route = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const auth = yield* ServerAuth;
  const config = yield* ServerConfig;
  const url = HttpServerRequest.toURL(request);
  if (!url)
    return HttpServerResponse.jsonUnsafe({ ok: false, error: "invalid_url" }, { status: 400 });
  if (
    shouldRejectUntrustedRequestOrigin({
      rawOrigin: request.headers.origin,
      requestOrigin: url.origin,
      config,
    })
  )
    return HttpServerResponse.jsonUnsafe(
      { ok: false, error: "trusted_origin_required" },
      { status: 403 },
    );
  // Use Synara's existing local-owner / authenticated-remote policy.
  const session = yield* authenticateRpcWebSocketUpgrade({
    config,
    legacyToken: url.searchParams.get("token"),
    request: makeEffectAuthRequest(request),
    serverAuth: auth,
  });
  if (session && session.role !== "owner")
    return HttpServerResponse.jsonUnsafe({ ok: false, error: "owner_required" }, { status: 403 });
  const origin = normalizeCorsOrigin(request.headers.origin);
  const headers = origin
    ? {
        "Access-Control-Allow-Origin": origin,
        "Access-Control-Allow-Credentials": "true",
        Vary: "Origin",
      }
    : {};
  const gates = yield* A2AGateService;
  if (request.method === "OPTIONS")
    return HttpServerResponse.empty({
      headers: {
        ...headers,
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
        "Access-Control-Max-Age": "600",
      },
    });
  if (url.pathname === "/api/a2a/membership") return yield* membershipRoute(request, headers);
  if (request.method === "GET") {
    const task = gates.taskForThread(url.searchParams.get("thread") ?? "");
    return HttpServerResponse.jsonUnsafe({ ok: true, task }, { headers });
  }
  const body = yield* readMcpJsonBody(request);
  if (body.kind !== "ok")
    return HttpServerResponse.jsonUnsafe({ ok: false, error: "invalid_body" }, { status: 400 });
  const args = yield* Schema.decodeUnknownEffect(A2AGateRequest)(body.body);
  return HttpServerResponse.jsonUnsafe(yield* Effect.promise(() => gates.call(args)), { headers });
}).pipe(
  Effect.catch((error) =>
    Effect.succeed(
      HttpServerResponse.jsonUnsafe(
        { ok: false, error: "request_failed", details: String(error) },
        { status: 400 },
      ),
    ),
  ),
);

export const a2aGateRouteLayer = Layer.mergeAll(
  HttpRouter.add("POST", "/api/a2a", route),
  HttpRouter.add("GET", "/api/a2a", route),
  HttpRouter.add("OPTIONS", "/api/a2a", route),
  HttpRouter.add("GET", "/api/a2a/membership", route),
  HttpRouter.add("POST", "/api/a2a/membership", route),
  HttpRouter.add("OPTIONS", "/api/a2a/membership", route),
);
