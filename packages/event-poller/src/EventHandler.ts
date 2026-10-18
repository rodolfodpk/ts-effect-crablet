import { Data, type Effect } from "effect";
import type { StoredEvent } from "@crablet/eventstore";

// Handles a batch of events for a processor. Implementations MUST be idempotent - delivery
// is at-least-once (handler execution and progress-cursor advance are not in the same transaction;
// the same batch may be re-delivered if progress tracking fails after successful handling).
//
// `E, R` generic defaults follow the same pattern as EventFetcher.ts (see that file's primer).
export interface EventHandler<I, E = never, R = never> {
  readonly handle: (
    processorId: I,
    events: ReadonlyArray<StoredEvent>
  ) => Effect.Effect<number, E | HandledPrefix, R>;
}

// A handler that failed part-way through a batch, after it had handled the first `handled` events, in order, for good (an outbox publisher that sends
// one event at a time). The processor moves its cursor past those, records `cause` as the error, and redelivers from the first event not handled,
// instead of the whole batch (ADR-0036). Only for a handler whose effects cannot be rolled back; a view's batch is all or nothing.
export class HandledPrefix extends Data.TaggedError("HandledPrefix")<{
  readonly handled: number;
  readonly cause: unknown;
}> {}
