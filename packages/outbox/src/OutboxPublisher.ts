import { Effect } from "effect";
import type { StoredEvent } from "@crablet/eventstore";

// Port of com.crablet.outbox.OutboxPublisher. Consumers implement this to push events to an
// external system (Kafka, webhooks, etc). `preferredMode` lets an implementation opt into
// one-event-per-call delivery instead of whole-batch delivery (e.g. a webhook API) - see
// internal/OutboxPublishingService.ts for how this gets dispatched.
export interface OutboxPublisher<E = unknown> {
  readonly name: string;
  readonly preferredMode?: "batch" | "individual";
  readonly publishBatch: (events: ReadonlyArray<StoredEvent>) => Effect.Effect<void, E, never>;
  readonly isHealthy?: () => boolean;
}

// Port of com.crablet.outbox.publishers.LogPublisher - a trivial reference implementation, useful
// as a default/example. StatisticsPublisher/GlobalStatisticsPublisher are explicitly not ported in
// this phase (not needed to prove the publisher contract out).
export const makeLogPublisher = (name = "LogPublisher"): OutboxPublisher<never> => ({
  name,
  publishBatch: (events) =>
    Effect.sync(() => {
      for (const event of events) {
        console.log(`[${name}] ${event.type} @ position ${event.position}`);
      }
    })
});
