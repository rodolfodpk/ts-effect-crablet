import { Effect } from "effect";
import type { SqlClient } from "effect/sql";
import type { EventSelection } from "./EventSelection.ts";
import { buildBacklogQuery } from "./internal/sql.ts";
import type { Backlog, BackoffInfo, ProcessorDetails, ProcessorManagementService, ProcessorStatus } from "@crablet/modules";
import type { ProgressTracker } from "./ProgressTracker.ts";

// The contract this implements (ProcessorManagementService and its data) is @crablet/modules's; the event-poller is one implementation of it.

// What is waiting for one processor is counted up to BACKLOG_CAP, so that a processor days behind does not make the count read millions of rows.
export const BACKLOG_CAP = 100_000;

export interface ProcessorManagementDeps<I> {
  readonly progressTracker: ProgressTracker<I>;
  readonly getAllStatuses: Effect.Effect<ReadonlyMap<I, ProcessorStatus>, unknown>;
  readonly pauseProcessor: (id: I) => Effect.Effect<void, unknown>;
  readonly resumeProcessor: (id: I) => Effect.Effect<void, unknown>;
  readonly backoffSnapshot: (id: I) => Effect.Effect<BackoffInfo | null>;
  readonly allBackoffSnapshots: Effect.Effect<ReadonlyMap<I, BackoffInfo>>;
  readonly sql: SqlClient.SqlClient;
  // Each processor's error count and last error, read from the module's progress table. Absent: `getAllDetails` is empty.
  readonly details?: Effect.Effect<ReadonlyMap<I, ProcessorDetails>, unknown>;
  // What each processor selects, for `getBacklog`. Absent: `getBacklog` answers null.
  readonly selectionOf?: (id: I) => EventSelection | undefined;
}

// pause/resume/reset all check existence via getAllStatuses().has(id), NOT getStatus(id) -
// getStatus defaults to "ACTIVE" for an unknown id, which would make every unknown id look valid if used for
// the existence check instead.
export const makeProcessorManagementService = <I>(
  deps: ProcessorManagementDeps<I>
): ProcessorManagementService<I> => {
  const withKnownId = (id: I, action: Effect.Effect<void, unknown>): Effect.Effect<boolean, unknown> =>
    Effect.gen(function* () {
      const statuses = yield* deps.getAllStatuses;
      if (!statuses.has(id)) return false;
      yield* action;
      return true;
    });

  const pause = (id: I): Effect.Effect<boolean, unknown> => withKnownId(id, deps.pauseProcessor(id));
  const resume = (id: I): Effect.Effect<boolean, unknown> => withKnownId(id, deps.resumeProcessor(id));

  // reset = resetErrorCount + setStatus("ACTIVE") + resume - does NOT rewind last_position.
  const reset = (id: I): Effect.Effect<boolean, unknown> =>
    withKnownId(
      id,
      Effect.gen(function* () {
        yield* deps.progressTracker.resetErrorCount(id);
        yield* deps.progressTracker.setStatus(id, "ACTIVE");
        yield* deps.resumeProcessor(id);
      })
    );

  const getStatus = (id: I): Effect.Effect<ProcessorStatus, unknown> => deps.progressTracker.getStatus(id);

  // Fresh DB read each call (not cached): MAX(position) - lastPosition, naturally
  // null if either side is null (empty events table, or no progress row yet).
  const getLag = (id: I): Effect.Effect<bigint | null, unknown> =>
    Effect.gen(function* () {
      const { position: lastPosition } = yield* deps.progressTracker.peekCursor(id);
      const rows = yield* deps.sql.unsafe<{ lag: string | null }>(
        "SELECT (SELECT MAX(position) FROM crablet_events) - $1::bigint AS lag",
        [lastPosition.toString()]
      );
      const lag = rows[0]?.lag;
      return lag === null || lag === undefined ? null : BigInt(lag);
    });

  const getBacklog = (id: I): Effect.Effect<Backlog | null, unknown> =>
    Effect.gen(function* () {
      const selection = deps.selectionOf?.(id);
      if (selection === undefined) return null;
      const cursor = yield* deps.progressTracker.peekCursor(id);
      const query = buildBacklogQuery(selection, cursor, BACKLOG_CAP);
      const rows = yield* deps.sql.unsafe<{ pending: string; oldest_seconds: number | null }>(query.sql, query.params);
      const pendingEvents = Number(rows[0]?.pending ?? 0);
      const oldest = rows[0]?.oldest_seconds;
      return {
        cursor,
        pendingEvents,
        capped: pendingEvents >= BACKLOG_CAP,
        oldestPendingSeconds: pendingEvents === 0 || oldest === null || oldest === undefined ? null : Math.max(0, oldest)
      };
    });

  return {
    pause,
    resume,
    reset,
    getStatus,
    getAllStatuses: deps.getAllStatuses,
    getLag,
    getBacklog,
    getAllDetails: deps.details ?? Effect.succeed(new Map<I, ProcessorDetails>()),
    getBackoffInfo: deps.backoffSnapshot,
    getAllBackoffInfo: deps.allBackoffSnapshots
  };
};
