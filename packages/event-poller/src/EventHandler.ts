import type { Effect } from "effect";
import type { StoredEvent } from "@crablet/eventstore";

// Port of com.crablet.eventpoller.EventHandler<I>. Implementations MUST be idempotent - delivery
// is at-least-once (handler execution and progress-cursor advance are not in the same transaction;
// the same batch may be re-delivered if progress tracking fails after successful handling).
//
// `E, R` generic defaults follow the same pattern as EventFetcher.ts (see that file's primer).
export interface EventHandler<I, E = never, R = never> {
  readonly handle: (
    processorId: I,
    events: ReadonlyArray<StoredEvent>
  ) => Effect.Effect<number, E, R>;
}
