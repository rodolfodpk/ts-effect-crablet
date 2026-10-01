import { Data, type Effect } from "effect";
import type { SqlError } from "effect/sql/SqlError";
import type { ProcessorStatus } from "./ProcessorStatus.ts";
import type { ProgressCursor } from "./ProgressCursor.ts";

// "Progress table not ready yet" - typed, instead of string-matching a message: PostgresProgressTracker maps Postgres SQLSTATE
// 42P01 (undefined_table) to this error, and EventProcessor's loop catches it as "not ready yet,
// return 0" - the migrations haven't run yet.
//
// `Data.TaggedError` - see eventstore's AppendErrors.ts for the full primer on this pattern. The
// `<{}>` (empty field set) just means this error carries no extra data beyond its `_tag` - the
// tag alone ("was the table missing, yes or no") is all the caller needs to branch on.
export class ProgressTableNotReady extends Data.TaggedError("ProgressTableNotReady")<{}> {}

// Tracks how far each processor has read.
export interface ProgressTracker<I> {
  // Where the processor resumes: the zero cursor when it has never run.
  readonly getCursor: (id: I) => Effect.Effect<ProgressCursor, SqlError | ProgressTableNotReady>;
  readonly updateCursor: (id: I, cursor: ProgressCursor) => Effect.Effect<void, SqlError>;
  readonly recordError: (id: I, error: string, maxErrors: number) => Effect.Effect<void, SqlError>;
  readonly resetErrorCount: (id: I) => Effect.Effect<void, SqlError>;
  // Defaults "ACTIVE" when no row exists yet.
  readonly getStatus: (id: I) => Effect.Effect<ProcessorStatus, SqlError>;
  readonly setStatus: (id: I, status: ProcessorStatus) => Effect.Effect<void, SqlError>;
  readonly autoRegister: (id: I, instanceId: string) => Effect.Effect<void, ProgressTableNotReady | SqlError>;
}
