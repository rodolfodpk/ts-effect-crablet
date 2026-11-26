import { Effect } from "effect";
import { HttpApiBuilder } from "effect/http-api";
import { isBackedOff } from "@crablet/modules";
import * as LogPoint from "@crablet/eventstore/LogPoint";
import type { ProcessorSource } from "@crablet/modules/ProcessorSource";
import { adminApi } from "./AdminApi.ts";
import { ProcessorNotFound, type ProcessorInfo } from "./ProcessorsApi.ts";

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
          cursor: backlog === null ? null : LogPoint.format(backlog.cursor),
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

// The handlers of `processorsGroup` over these sources, typed by the endpoints (`HttpApiBuilder.handler`): a handler that returned the wrong shape, read a
// parameter the endpoint does not have, or needed a service would not compile. `adminApiLayer` (AdminApiLive.ts) registers them; an application that puts the
// group in an API of its own registers them in its `HttpApiBuilder.group(api, "processors", ...)`, which its concrete API types in full. Two sources of
// the same kind are refused.
export const processorsHandlers = (sources: ReadonlyArray<ProcessorSource>) => {
  const kinds = sources.map((s) => s.kind);
  const duplicate = kinds.find((k, i) => kinds.indexOf(k) !== i);
  if (duplicate !== undefined) throw new Error(`processor kind "${duplicate}" is used by more than one source`);
  return {
    listProcessors: HttpApiBuilder.handler(adminApi, "processors", "listProcessors", () => Effect.map(listProcessors(sources), (processors) => ({ processors }))),
    pauseProcessor: HttpApiBuilder.handler(adminApi, "processors", "pauseProcessor", ({ params }) => actOnProcessor(sources, "pause", params.kind, params.id)),
    resumeProcessor: HttpApiBuilder.handler(adminApi, "processors", "resumeProcessor", ({ params }) => actOnProcessor(sources, "resume", params.kind, params.id)),
    resetProcessor: HttpApiBuilder.handler(adminApi, "processors", "resetProcessor", ({ params }) => actOnProcessor(sources, "reset", params.kind, params.id))
  };
};
