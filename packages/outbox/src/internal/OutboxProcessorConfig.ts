import { processorConfigFrom, type ProcessorConfig } from "@crablet/event-poller/ProcessorConfig";
import type { OutboxConfig } from "../OutboxConfig.ts";
import type { TopicConfig } from "../TopicConfig.ts";
import * as TopicPublisherPair from "../TopicPublisherPair.ts";

// Cross-joins each topic's declared publishers: one ProcessorConfig per (topic, publisher), from the defaults, the module's config, then the publisher's own
// optional overrides.
export const makeOutboxProcessorConfigs = (
  config: OutboxConfig = {},
  topics: ReadonlyArray<TopicConfig>
): ReadonlyArray<ProcessorConfig<string>> =>
  topics.flatMap((topicConfig) =>
    topicConfig.publishers.map((assignment) =>
      processorConfigFrom(TopicPublisherPair.toKey({ topic: topicConfig.topic, publisher: assignment.name }), config, assignment)
    )
  );
