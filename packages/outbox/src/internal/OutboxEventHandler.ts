import { Effect, Metric } from "effect";
import type { StoredEvent } from "@crablet/eventstore";
import type { EventHandler } from "@crablet/event-poller/EventHandler";
import * as OutboxMetrics from "@crablet/metrics-otel/OutboxMetrics";
import { fromKey } from "../TopicPublisherPair.ts";
import { OutboxPublishers } from "../OutboxPublisher.ts";
import { publishToOutbox } from "./OutboxPublishingService.ts";
import { defaultPublishTimeoutMs } from "../OutboxConfig.ts";

// Decodes the publisher name from the pair key, looks it up in the publishers the processor was started with (`OutboxPublishers`, read where it runs),
// delegates to OutboxPublishingService; dies loudly on a name with no publisher (a misconfiguration, not a recoverable typed failure).
export const makeOutboxEventHandler = (publishTimeoutMs: number = defaultPublishTimeoutMs): EventHandler<string, unknown, OutboxPublishers> => {
  const handle = (key: string, events: ReadonlyArray<StoredEvent>): Effect.Effect<number, unknown, OutboxPublishers> =>
    Effect.flatMap(Effect.service(OutboxPublishers), (publishers) => {
    const { publisher: publisherName } = fromKey(key);
    const publisher = Object.hasOwn(publishers, publisherName) ? publishers[publisherName] : undefined;
    if (!publisher) return Effect.die(new Error(`Unknown publisher: ${publisherName}`));

    return OutboxMetrics.observe(
      OutboxMetrics.publish,
      publishToOutbox(publisherName, publisher, events, publishTimeoutMs).pipe(
        Effect.tap((handled) =>
          Metric.update(Metric.withAttributes(OutboxMetrics.eventsPublished, { publisher: publisherName }), handled)
        )
      ),
      [["publisher", publisherName]]
    );
    });

  return { handle };
};
