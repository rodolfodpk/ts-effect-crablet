import { processorConfigFrom, type ProcessorConfig } from "@crablet/event-poller/ProcessorConfig";
import type { OutboxConfig } from "../OutboxConfig.ts";
import type { OutboxPublisher } from "../OutboxPublisher.ts";
import type { TopicConfig } from "../TopicConfig.ts";
import * as TopicPublisherPair from "../TopicPublisherPair.ts";

// Cross-joins each topic's declared publishers: one ProcessorConfig per (topic, publisher), from the defaults, the module's config, then the publisher's own
// optional overrides.
export const makeOutboxProcessorConfigs = (
  config: OutboxConfig = {},
  topics: ReadonlyArray<TopicConfig>
): ReadonlyArray<ProcessorConfig<string>> =>
  topics.flatMap((topicConfig) =>
    topicConfig.publishers.map(({ publisher, ...overrides }) =>
      processorConfigFrom(TopicPublisherPair.toKey({ topic: topicConfig.topic, publisher: publisher.name }), config, overrides)
    )
  );

// The publishers of the topics, once each. A publisher's progress is kept by its name, so one name must be one publisher: two different
// publishers under one name are refused when the processor is built.
export const publishersOf = (topics: ReadonlyArray<TopicConfig>): ReadonlyArray<OutboxPublisher<any>> => {
  const byName = new Map<string, OutboxPublisher<any>>();
  for (const { publisher } of topics.flatMap((t) => t.publishers)) {
    const seen = byName.get(publisher.name);
    if (seen !== undefined && seen !== publisher) {
      throw new Error(`outbox: two different publishers are named "${publisher.name}"; a publisher's progress is kept by its name, so give each its own`);
    }
    byName.set(publisher.name, publisher);
  }
  return [...byName.values()];
};
