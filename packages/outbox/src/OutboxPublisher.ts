import { Effect } from "effect";
import type { StoredEvent } from "@crablet/eventstore";

// Consumers implement this to push events to an
// external system (Kafka, webhooks, etc). `preferredMode` lets an implementation opt into
// one-event-per-call delivery instead of whole-batch delivery (e.g. a webhook API) - see
// internal/OutboxPublishingService.ts for how this gets dispatched.
// Delivery is at-least-once: after a crash between the publish and the cursor, a publish that timed out, or when a zombie leader and its successor take
// the same batch, the same events are published again (ADR-0036). Events arrive in (transactionId, position) order, and a repeat only ever goes back to
// where the cursor last stood. So:
//   - give the destination `event.eventId` as the message id: it is the same on every republish, so a broker that deduplicates by id (SQS FIFO
//     MessageDeduplicationId, NATS Nats-Msg-Id, Azure Service Bus MessageId, a CloudEvents `id`) drops the repeat for you;
//   - a consumer that keeps the order it receives can skip anything at or below the last (transactionId, position) it applied, saved together with
//     what it applied. Not `position` alone: a later event can have a smaller position. Not `eventId`: it is an id, not an order;
//   - a consumer that does not keep the order keeps the set of `eventId`s it has seen.
// (A repeat is accepted for the outbox; an automation, by contrast, must be idempotent - see defineAutomation.)
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
        console.log(`[${name}] ${event.type} @ (${event.transactionId}, ${event.position}) id ${event.eventId}`);
      }
    })
});
