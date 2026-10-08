import { Effect, Layer } from "effect";
import { HttpApiBuilder } from "effect/http-api";
import type { HttpApi, HttpApiGroup } from "effect/http-api";
import { isBackedOff, type ProcessorManagementService } from "@crablet/event-poller/ProcessorManagementService";
import { ProcessorNotFound, type ProcessorInfo } from "./ProcessorsApi.ts";

// One module's processors, as the application names them. `kind` is the word a client sees (views, automations, outbox, or anything else);
// `service` is that module's management service (`makeViewManagementService(handle)` and its siblings). `describe` says what a processor is for.
export interface ProcessorSource {
  readonly kind: string;
  readonly service: ProcessorManagementService<string>;
  readonly describe?: (id: string) => string | undefined;
}

export type ProcessorAction = "pause" | "resume" | "reset";

// Every processor of every source, sorted by kind and id, with its status, failure details, cursor, backlog and backoff. A processor whose backlog cannot be read
// is still listed, with the backlog fields null; a source whose statuses cannot be read fails the call (it is a database failure, not a missing processor).
export const listProcessors = (sources: ReadonlyArray<ProcessorSource>): Effect.Effect<ReadonlyArray<ProcessorInfo>> =>
  Effect.gen(function* () {
    const out: Array<ProcessorInfo> = [];
    for (const { kind, service, describe } of sources) {
      const statuses = yield* service.getAllStatuses;
      const details = yield* service.getAllDetails;
      const backoff = yield* service.getAllBackoffInfo;
      for (const [id, status] of statuses) {
        const backlog = yield* Effect.catch(service.getBacklog(id), () => Effect.succeed(null));
        const detail = details.get(id);
        const backoffInfo = backoff.get(id);
        out.push({
          kind,
          id,
          description: describe?.(id) ?? null,
          status,
          errorCount: detail?.errorCount ?? null,
          lastError: detail?.lastError ?? null,
          cursorPosition: backlog === null ? null : backlog.cursor.position.toString(),
          pendingEvents: backlog?.pendingEvents ?? null,
          pendingCapped: backlog?.capped ?? false,
          oldestPendingSeconds: backlog?.oldestPendingSeconds ?? null,
          backedOff: backoffInfo === undefined ? false : isBackedOff(backoffInfo)
        });
      }
    }
    return out.sort((a, b) => (a.kind === b.kind ? a.id.localeCompare(b.id) : a.kind.localeCompare(b.kind)));
  }).pipe(Effect.orDie);

// Pause, resume or reset one processor. Fails with ProcessorNotFound for a kind or an id the sources do not have (the services answer `false` for an unknown id).
// `reset` clears the error count, sets the status to ACTIVE and resumes the processor; it does not move its cursor.
export const actOnProcessor = (
  sources: ReadonlyArray<ProcessorSource>,
  action: ProcessorAction,
  kind: string,
  id: string
): Effect.Effect<{ readonly kind: string; readonly id: string; readonly status: ProcessorInfo["status"] }, ProcessorNotFound> =>
  Effect.gen(function* () {
    const source = sources.find((s) => s.kind === kind);
    if (source === undefined) return yield* Effect.fail(ProcessorNotFound.of(kind, undefined));
    const done = yield* source.service[action](id).pipe(Effect.orDie);
    if (!done) return yield* Effect.fail(ProcessorNotFound.of(kind, id));
    const status = yield* source.service.getStatus(id).pipe(Effect.orDie);
    return { kind, id, status };
  });

// The handlers of `processorsGroup` (ProcessorsApi.ts) over these sources, for an `HttpApi` that contains the group. The layer builds with no requirements, but the
// server needs `ProcessorsAuthorization` (provide `authorizationFrom(...)`, Authorization.ts, or your own) or it fails to start; the type does not say so.
// Same `any`-cast composability boundary as commands-http's makeCommandApiGroupLive: `HttpApiBuilder.group`'s signature cannot prove that an arbitrary caller-supplied
// `Groups` contains this literal group name.
export const makeProcessorsApiGroupLive = <ApiId extends string, Groups extends HttpApiGroup.Constraint>(
  api: HttpApi.HttpApi<ApiId, Groups>,
  sources: ReadonlyArray<ProcessorSource>
): Layer.Layer<HttpApiGroup.Service<ApiId, "processors">> => {
  const kinds = sources.map((s) => s.kind);
  const duplicate = kinds.find((k, i) => kinds.indexOf(k) !== i);
  if (duplicate !== undefined) throw new Error(`processor kind "${duplicate}" is used by more than one source`);
  const groupBuilder = HttpApiBuilder.group as any;
  return groupBuilder(api, "processors", (handlers: any) =>
    Effect.succeed(
      handlers
        .handle("listProcessors", () => Effect.map(listProcessors(sources), (processors) => ({ processors })))
        .handle("pauseProcessor", ({ params }: { params: { kind: string; id: string } }) => actOnProcessor(sources, "pause", params.kind, params.id))
        .handle("resumeProcessor", ({ params }: { params: { kind: string; id: string } }) => actOnProcessor(sources, "resume", params.kind, params.id))
        .handle("resetProcessor", ({ params }: { params: { kind: string; id: string } }) => actOnProcessor(sources, "reset", params.kind, params.id))
    )
  );
};
