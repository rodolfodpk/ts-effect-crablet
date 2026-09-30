import { Effect } from "effect";
import type { StoredEvent } from "@crablet/eventstore";

// Consumers implement this to push events to an
// external system (Kafka, webhooks, etc). `preferredMode` lets an implementation opt into
// one-event-per-call delivery instead of whole-batch delivery (e.g. a webhook API) - see
// internal/OutboxPublishingService.ts for how this gets dispatched.
export interface OutboxPublisher<E = unknown> {
  readonly name: string;
  readonly preferredMode?: "batch" | "individual";
  readonly publishBatch: (events: ReadonlyArray<StoredEvent>) => Effect.Effect<void, E, never>;
  readonly isHealthy?: () => boolean;
}

// A trivial reference implementation that logs, useful as a default/example.
export const makeLogPublisher = (name = "LogPublisher"): OutboxPublisher<never> => ({
  name,
  publishBatch: (events) =>
    Effect.sync(() => {
      for (const event of events) {
        console.log(`[${name}] ${event.type} @ position ${event.position}`);
      }
    })
});
