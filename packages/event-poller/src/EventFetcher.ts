import type { Effect } from "effect";
import type { StoredEvent } from "@crablet/eventstore";

// Port of com.crablet.eventpoller.EventFetcher<I>. Java's `throws Exception` becomes Effect's
// typed error channel - E defaults to `never` for fetchers that can't fail beyond defects.
export interface EventFetcher<I, E = never, R = never> {
  readonly fetchEvents: (
    processorId: I,
    lastPosition: bigint,
    batchSize: number
  ) => Effect.Effect<ReadonlyArray<StoredEvent>, E, R>;
}
