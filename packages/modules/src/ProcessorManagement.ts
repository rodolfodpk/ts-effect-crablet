// The contract of a module's management service: what an operator (the admin API, a status page, a metrics sampler) can ask of a module's processors and do
// to them, and the data it answers with. It is a contract, not an implementation: `@crablet/event-poller` implements it (makeProcessorManagementService), and
// every module (views, automations, outbox, deadlines) hands one out. Moved here from the event-poller so that what consumes it (the admin API, @crablet/app)
// depends on the contract, not on the engine (decision V2, docs/adr/0054).
import type { Effect } from "effect";

// A plain string-literal union - matches
// the `status` TEXT column (CHECK-constrained to these three values) directly, no encode/decode step.
//
// PATTERN NOTE: a string-literal union (`"ACTIVE" | "PAUSED" | "FAILED"`) is TypeScript's
// lightest-weight enum equivalent - unlike TS's own `enum` keyword (which generates a runtime
// object), this is a *type-only* construct: it
// exists purely for the compiler, compiles away to nothing, and the runtime value is just the
// plain string itself. That's exactly what's wanted here - the value flows straight in and out of
// a Postgres TEXT column with no translation step, and `switch`/`===` comparisons against it work
// exactly like comparing plain strings, because that's all they are.
export type ProcessorStatus = "ACTIVE" | "PAUSED" | "FAILED";

// How far a processor has read: a point in the log in (transaction_id, position) order. It is `LogPoint` (`@crablet/eventstore/LogPoint`), the
// type of a write marker too, declared here so this package depends on no other; `@crablet/event-poller` keeps the two equal by a type test.
//
// Not a bare position: `position` is taken from a sequence when a row is inserted and `transaction_id` is the
// xid of the inserting transaction, and the two can come in opposite orders. A cursor on the position alone can
// move past a row that commits later with a LOWER position and so skip it for ever. Events are fetched in
// (transaction_id, position) order, bounded by the snapshot's xmin, and a row that appears after a fetch always
// sorts after everything fetched, so this cursor cannot skip one (see docs/history/plans/poller-cursor-fix.md).
export interface ProgressCursor {
  readonly transactionId: string;
  readonly position: bigint;
}

// Backoff info for a processor. Structurally
// identical to EventProcessor.ts's BackoffSnapshot (both `{emptyPollCount, currentSkipCounter}`) -
// deliberately not imported from there to avoid a circular dependency; TS structural typing makes
// values from either module interchangeable without an explicit import.
export interface BackoffInfo {
  readonly emptyPollCount: number;
  readonly currentSkipCounter: number;
}

export const isBackedOff = (info: BackoffInfo): boolean => info.currentSkipCounter > 0;

// What is waiting for one processor: the committed events its own selection matches after its cursor. Counted up to BACKLOG_CAP so that a processor
// days behind does not make the count read millions of rows; `capped` says the true number is at least `pendingEvents`.
export interface Backlog {
  readonly cursor: ProgressCursor;
  readonly pendingEvents: number;
  readonly capped: boolean;
  // Age, by the events' own `occurred_at`, of the first pending event; null when nothing is pending. `occurred_at` can be supplied by the
  // writer, so this is the event's time, not the time it was stored.
  readonly oldestPendingSeconds: number | null;
}

// What a processor's progress row says about its failures: how many errors in a row, and the last one's text.
export interface ProcessorDetails {
  readonly errorCount: number;
  readonly lastError: string | null;
}

// Pause/resume/reset and status inspection for processors.
export interface ProcessorManagementService<I> {
  readonly pause: (processorId: I) => Effect.Effect<boolean, unknown>;
  readonly resume: (processorId: I) => Effect.Effect<boolean, unknown>;
  readonly reset: (processorId: I) => Effect.Effect<boolean, unknown>;
  readonly getStatus: (processorId: I) => Effect.Effect<ProcessorStatus, unknown>;
  readonly getAllStatuses: Effect.Effect<ReadonlyMap<I, ProcessorStatus>, unknown>;
  // Positions between the head of the WHOLE log and the cursor. A cursor only lands on events the processor selected, so for a processor that
  // selects a rare event type this stays large while it is fully caught up; use `getBacklog` to ask whether it is behind.
  readonly getLag: (processorId: I) => Effect.Effect<bigint | null, unknown>;
  // The processor's own pending events (see Backlog); null for an id whose selection is not known to this service.
  readonly getBacklog: (processorId: I) => Effect.Effect<Backlog | null, unknown>;
  // The failure details of every processor that has a progress row (a processor that never ran has none).
  readonly getAllDetails: Effect.Effect<ReadonlyMap<I, ProcessorDetails>, unknown>;
  readonly getBackoffInfo: (processorId: I) => Effect.Effect<BackoffInfo | null>;
  readonly getAllBackoffInfo: Effect.Effect<ReadonlyMap<I, BackoffInfo>>;
}
