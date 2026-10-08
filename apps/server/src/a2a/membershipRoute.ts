import { join } from "node:path";
import { A2AMembership, MembershipRefusal } from "@synara/a2a-gates/membership";
import { A2AMembershipSaveRequest } from "@synara/contracts";
import { Effect, Option, Schema } from "effect";
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import { ServerConfig } from "../config";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery";
import { readMcpJsonBody } from "../agentGateway/httpRoute";
import { A2AGateService } from "./service";

/** Called only after the existing gate route's origin and owner checks. */
export function membershipRoute(
  request: HttpServerRequest.HttpServerRequest,
  headers: Record<string, string>,
) {
  return Effect.gen(function* () {
    const config = yield* ServerConfig;
    const url = HttpServerRequest.toURL(request)!;
    const store = new A2AMembership(join(config.stateDir, "a2a-gates"));
    try {
      if (request.method === "GET")
        return HttpServerResponse.jsonUnsafe(
          { ok: true, tasks: store.list(url.searchParams.get("project") ?? undefined) },
          { headers },
        );
      const body = yield* readMcpJsonBody(request);
      if (body.kind !== "ok")
        return HttpServerResponse.jsonUnsafe(
          { ok: false, error: "invalid_body" },
          { status: 400, headers },
        );
      const { task } = yield* Schema.decodeUnknownEffect(A2AMembershipSaveRequest)(body.body);
      const query = yield* ProjectionSnapshotQuery;
      const project = yield* query.getProjectShellById(task.projectId);
      if (Option.isNone(project))
        return HttpServerResponse.jsonUnsafe(
          { ok: false, error: "unknown_project" },
          { status: 400, headers },
        );
      const gates = yield* A2AGateService;
      const status = yield* Effect.promise(() =>
        gates.call({ command: "status", task: task.taskId }),
      );
      if (!status.ok && status.error !== "unknown_task")
        return HttpServerResponse.jsonUnsafe(status, { status: 400, headers });
      if (status.task && status.task.project_id !== task.projectId)
        return HttpServerResponse.jsonUnsafe(
          { ok: false, error: "gate_project_mismatch" },
          { status: 400, headers },
        );
      const threads = yield* query.getThreadShellsByIds(
        task.members.map((member) => member.threadId),
      );
      for (const member of task.members) {
        const thread = threads.find((thread) => thread.id === member.threadId);
        if (!thread)
          return HttpServerResponse.jsonUnsafe(
            { ok: false, error: "unknown_thread" },
            { status: 400, headers },
          );
        if (thread.projectId !== task.projectId)
          return HttpServerResponse.jsonUnsafe(
            { ok: false, error: "thread_project_mismatch" },
            { status: 400, headers },
          );
      }
      try {
        return HttpServerResponse.jsonUnsafe({ ok: true, task: store.save(task) }, { headers });
      } catch (error) {
        if (!(error instanceof MembershipRefusal)) throw error;
        return HttpServerResponse.jsonUnsafe(
          { ok: false, error: error.code },
          {
            status: error.code === "duplicate_member" ? 400 : 409,
            headers,
          },
        );
      }
    } finally {
      store.close();
    }
  });
}
