import { A2ARolePermissionsRequest } from "@synara/contracts";
import { RolePermissionRefusal } from "@synara/a2a-gates/rolePermissions";
import { Effect, Schema } from "effect";
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import { readMcpJsonBody } from "../agentGateway/httpRoute";
import { A2AGateService } from "./service";

/** The existing a2a route authenticates the owner and trusted origin first. */
export function rolePermissionsRoute(
  request: HttpServerRequest.HttpServerRequest,
  headers: Record<string, string>,
) {
  return Effect.gen(function* () {
    const gates = yield* A2AGateService;
    if (request.method === "GET")
      return HttpServerResponse.jsonUnsafe(gates.rolePermissionSettings(), { headers });
    const body = yield* readMcpJsonBody(request);
    if (body.kind !== "ok")
      return HttpServerResponse.jsonUnsafe({ error: "invalid_body" }, { status: 400, headers });
    const args = yield* Schema.decodeUnknownEffect(A2ARolePermissionsRequest)(body.body);
    return yield* Effect.try({
      try: () => HttpServerResponse.jsonUnsafe(gates.saveRolePermissionSettings(args), { headers }),
      catch: (error) => error,
    }).pipe(
      Effect.catch((error) => {
        if (!(error instanceof RolePermissionRefusal)) return Effect.fail(error);
        return Effect.succeed(
          HttpServerResponse.jsonUnsafe(
            { error: error.code },
            { status: error.code === "stale_revision" ? 409 : 400, headers },
          ),
        );
      }),
    );
  });
}
