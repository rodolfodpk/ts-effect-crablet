import { Data, type Effect } from "effect";
import type { SqlError } from "@effect/sql/SqlError";
import type { ProcessorStatus } from "./ProcessorStatus.ts";

// Port of the "relation does not exist" swallowing EventProcessorImpl.process() does ad hoc via
// message-matching, and ProgressTracker.autoRegister's own internal swallow. Made explicit and
// typed here instead of relying on string-matching: PostgresProgressTracker maps Postgres SQLSTATE
// 42P01 (undefined_table) to this error, and EventProcessor's loop catches it as "not ready yet,
// return 0" - same external behavior (Flyway hasn't run yet), more robust detection.
export class ProgressTableNotReady extends Data.TaggedError("ProgressTableNotReady")<{}> {}

// Port of com.crablet.eventpoller.progress.ProgressTracker<I>.
export interface ProgressTracker<I> {
  readonly getLastPosition: (id: I) => Effect.Effect<bigint, SqlError | ProgressTableNotReady>;
  readonly updateProgress: (id: I, position: bigint) => Effect.Effect<void, SqlError>;
  readonly recordError: (id: I, error: string, maxErrors: number) => Effect.Effect<void, SqlError>;
  readonly resetErrorCount: (id: I) => Effect.Effect<void, SqlError>;
  // Defaults "ACTIVE" when no row exists yet, matching Java's documented behavior.
  readonly getStatus: (id: I) => Effect.Effect<ProcessorStatus, SqlError>;
  readonly setStatus: (id: I, status: ProcessorStatus) => Effect.Effect<void, SqlError>;
  readonly autoRegister: (id: I, instanceId: string) => Effect.Effect<void, ProgressTableNotReady | SqlError>;
}
