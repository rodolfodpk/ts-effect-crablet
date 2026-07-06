import { Effect } from "effect";
import type { StoredEvent } from "@crablet/eventstore";
import type { OutboxPublisher } from "../OutboxPublisher.ts";

// Port of com.crablet.outbox.publishing.OutboxPublishingServiceImpl: calls publishBatch once for
// the whole batch, or once per event if the publisher opts into "individual" mode.
export const publishToOutbox = (
  publisher: OutboxPublisher,
  events: ReadonlyArray<StoredEvent>
): Effect.Effect<number, unknown, never> =>
  publisher.preferredMode === "individual"
    ? Effect.forEach(events, (event) => publisher.publishBatch([event]), { discard: true }).pipe(
        Effect.map(() => events.length)
      )
    : publisher.publishBatch(events).pipe(Effect.map(() => events.length));
