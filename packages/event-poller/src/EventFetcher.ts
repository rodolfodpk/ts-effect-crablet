import type { Effect } from "effect";
import type { StoredEvent } from "@crablet/eventstore";
import type { ProgressCursor } from "./ProgressCursor.ts";

// Fetches the next batch of events for a processor: the events AFTER `cursor` in (transaction_id, position)
// order, from transactions that have finished (see ProgressCursor.ts). Failures go in Effect's typed error channel -
// E defaults to `never` for fetchers that can't fail beyond defects.
//
// PATTERN NOTE - generic type parameters with defaults (`E = never, R = never`). Any concrete `EventFetcher` implementation fills in its OWN error/requirement types
// (e.g. event-poller's `SqlEventFetcher.ts` produces `EventFetcher<I, SqlError, never>`, an
// in-memory test double produces `EventFetcher<I, never, never>`), while code that's generic over
// "any fetcher" (like `EventProcessor.ts`) can write `EventFetcher<I, unknown, never>` to accept
// whichever concrete error type without caring what it is. Defaulting both to `never` here means
// "no failure, no ambient dependency" is the assumed common case unless a call site says
// otherwise - consistent with the `Effect<A, E, R>` primer in eventstore's EventStore.ts.
export interface EventFetcher<I, E = never, R = never> {
  readonly fetchEvents: (
    processorId: I,
    cursor: ProgressCursor,
    batchSize: number
  ) => Effect.Effect<ReadonlyArray<StoredEvent>, E, R>;
}
