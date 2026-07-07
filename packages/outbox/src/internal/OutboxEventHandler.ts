import { Effect, Metric } from "effect";
import type { StoredEvent } from "@crablet/eventstore";
import type { EventHandler } from "@crablet/event-poller/EventHandler";
import * as OutboxMetrics from "@crablet/metrics-otel/OutboxMetrics";
import { fromKey } from "../TopicPublisherPair.ts";
import type { OutboxPublisher } from "../OutboxPublisher.ts";
import { publishToOutbox } from "./OutboxPublishingService.ts";

// Port of internal.OutboxEventHandler.java: decodes the publisher name from the pair key, looks up
// the registered OutboxPublisher, delegates to OutboxPublishingService; dies loudly on an
// unregistered publisher (a misconfiguration, not a recoverable typed failure).
export const makeOutboxEventHandler = (
  publishers: ReadonlyArray<OutboxPublisher>
): EventHandler<string, unknown, never> => {
  const byName = new Map(publishers.map((p) => [p.name, p] as const));

  const handle = (key: string, events: ReadonlyArray<StoredEvent>): Effect.Effect<number, unknown, never> => {
    const { publisher: publisherName } = fromKey(key);
    const publisher = byName.get(publisherName);
    if (!publisher) return Effect.die(new Error(`Unknown publisher: ${publisherName}`));

    return OutboxMetrics.observe(
      OutboxMetrics.publish,
      publishToOutbox(publisher, events).pipe(
        Effect.tap((handled) =>
          Metric.incrementBy(Metric.tagged(OutboxMetrics.eventsPublished, "publisher", publisherName), handled)
        )
      ),
      [["publisher", publisherName]]
    );
  };

  return { handle };
};
