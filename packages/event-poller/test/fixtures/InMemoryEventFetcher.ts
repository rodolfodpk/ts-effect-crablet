import { Effect, Ref } from "effect";
import type { StoredEvent } from "@crablet/eventstore";
import type { EventFetcher } from "../../src/EventFetcher.ts";
import * as ProgressCursorNS from "../../src/ProgressCursor.ts";

// Fast, in-memory EventFetcher double - filters a fixed in-memory event list by cursor ((transaction_id, position) order)/batchSize
// only (no EventSelection filtering; that's covered by sql-event-fetcher.test.ts against real
// Postgres, since the WHERE-clause logic has no meaningful in-memory equivalent worth testing here).
export const makeInMemoryEventFetcher = <I>(
  eventsRef: Ref.Ref<ReadonlyArray<StoredEvent>>
): EventFetcher<I, never, never> => ({
  fetchEvents: (_processorId, cursor, batchSize) =>
    Effect.map(Ref.get(eventsRef), (events) =>
      events
        .filter((e) => ProgressCursorNS.compare(ProgressCursorNS.after(e), cursor) > 0)
        .sort((a, b) => ProgressCursorNS.compare(ProgressCursorNS.after(a), ProgressCursorNS.after(b)))
        .slice(0, batchSize)
    )
});
