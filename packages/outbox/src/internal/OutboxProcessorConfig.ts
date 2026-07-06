import { processorConfigOf, type ProcessorConfig } from "@crablet/event-poller/ProcessorConfig";
import { resolveOverride } from "@crablet/event-poller/ProcessorRuntimeOverrides";
import type { OutboxConfig } from "../OutboxConfig.ts";
import type { TopicConfig } from "../TopicConfig.ts";
import * as TopicPublisherPair from "../TopicPublisherPair.ts";

// Port of internal.OutboxProcessorConfig.java's createConfigMap: cross-joins each topic's declared
// publishers against the module's global OutboxConfig defaults (+ each publisher's own optional
// runtime overrides).
export const makeOutboxProcessorConfigs = (
  config: OutboxConfig,
  topics: ReadonlyArray<TopicConfig>
): ReadonlyArray<ProcessorConfig<string>> =>
  topics.flatMap((topicConfig) =>
    topicConfig.publishers.map((assignment) =>
      processorConfigOf(
        TopicPublisherPair.toKey({ topic: topicConfig.topic, publisher: assignment.name }),
        {
          pollingIntervalMs: resolveOverride(assignment.pollingIntervalMs, config.pollingIntervalMs),
          batchSize: resolveOverride(assignment.batchSize, config.batchSize),
          backoffEnabled: resolveOverride(assignment.backoffEnabled, config.backoffEnabled),
          backoffThreshold: resolveOverride(assignment.backoffThreshold, config.backoffThreshold),
          backoffMultiplier: resolveOverride(assignment.backoffMultiplier, config.backoffMultiplier),
          backoffMaxSeconds: resolveOverride(assignment.backoffMaxSeconds, config.backoffMaxSeconds),
          leaderElectionRetryIntervalMs: config.leaderElectionRetryIntervalMs,
          maxErrors: config.maxErrors,
          enabled: config.enabled
        }
      )
    )
  );
