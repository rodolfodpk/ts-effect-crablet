import { Effect } from "effect";
import type { SqlClient } from "@effect/sql";
import type { ProcessorStatus } from "./ProcessorStatus.ts";
import type { ProgressTracker } from "./ProgressTracker.ts";

// Port of com.crablet.eventpoller.management.ProcessorManagementService.BackoffInfo. Structurally
// identical to EventProcessor.ts's BackoffSnapshot (both `{emptyPollCount, currentSkipCounter}`) -
// deliberately not imported from there to avoid a circular dependency; TS structural typing makes
// values from either module interchangeable without an explicit import.
export interface BackoffInfo {
  readonly emptyPollCount: number;
  readonly currentSkipCounter: number;
}

export const isBackedOff = (info: BackoffInfo): boolean => info.currentSkipCounter > 0;

// Port of com.crablet.eventpoller.management.ProcessorManagementService<I>.
export interface ProcessorManagementService<I> {
  readonly pause: (processorId: I) => Effect.Effect<boolean, unknown>;
  readonly resume: (processorId: I) => Effect.Effect<boolean, unknown>;
  readonly reset: (processorId: I) => Effect.Effect<boolean, unknown>;
  readonly getStatus: (processorId: I) => Effect.Effect<ProcessorStatus, unknown>;
  readonly getAllStatuses: Effect.Effect<ReadonlyMap<I, ProcessorStatus>, unknown>;
  readonly getLag: (processorId: I) => Effect.Effect<bigint | null, unknown>;
  readonly getBackoffInfo: (processorId: I) => Effect.Effect<BackoffInfo | null>;
  readonly getAllBackoffInfo: Effect.Effect<ReadonlyMap<I, BackoffInfo>>;
}

export interface ProcessorManagementDeps<I> {
  readonly progressTracker: ProgressTracker<I>;
  readonly getAllStatuses: Effect.Effect<ReadonlyMap<I, ProcessorStatus>, unknown>;
  readonly pauseProcessor: (id: I) => Effect.Effect<void, unknown>;
  readonly resumeProcessor: (id: I) => Effect.Effect<void, unknown>;
  readonly backoffSnapshot: (id: I) => Effect.Effect<BackoffInfo | null>;
  readonly allBackoffSnapshots: Effect.Effect<ReadonlyMap<I, BackoffInfo>>;
  readonly sql: SqlClient.SqlClient;
}

// Port of ProcessorManagementServiceImpl.java. pause/resume/reset all check existence via
// getAllStatuses().has(id), NOT getStatus(id) - getStatus defaults to "ACTIVE" for an unknown id
// (matching Java's documented behavior), which would make every unknown id look valid if used for
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

  // Fresh DB read each call (not cached), matching Java: MAX(position) - lastPosition, naturally
  // null if either side is null (empty events table, or no progress row yet).
  const getLag = (id: I): Effect.Effect<bigint | null, unknown> =>
    Effect.gen(function* () {
      const lastPosition = yield* deps.progressTracker.getLastPosition(id);
      const rows = yield* deps.sql.unsafe<{ lag: string | null }>(
        "SELECT (SELECT MAX(position) FROM crablet_events) - $1::bigint AS lag",
        [lastPosition.toString()]
      );
      const lag = rows[0]?.lag;
      return lag === null || lag === undefined ? null : BigInt(lag);
    });

  return {
    pause,
    resume,
    reset,
    getStatus,
    getAllStatuses: deps.getAllStatuses,
    getLag,
    getBackoffInfo: deps.backoffSnapshot,
    getAllBackoffInfo: deps.allBackoffSnapshots
  };
};
