import { Effect } from "effect";
import { SqlClient } from "@effect/sql";
import type { SqlError } from "@effect/sql/SqlError";
import type { StoredEvent } from "@crablet/eventstore";
import type { EventFetcher } from "@crablet/event-poller/EventFetcher";
import { makeSqlEventFetcher } from "@crablet/event-poller/SqlEventFetcher";
import { fromKey } from "../TopicPublisherPair.ts";
import type { TopicConfig } from "../TopicConfig.ts";

// One makeSqlEventFetcher instance per TOPIC (not per pair) - publishers on the same topic share
// one selection/fetch query, matching Java's internal.OutboxEventFetcher deriving its filter from
// processorId.topic(). Dispatched by decoding the topic out of the pair key - reuses
// event-poller's shared selection-keyed fetcher logic as-is, same pattern as
// packages/views/src/internal/ViewEventFetcher.ts.
export const makeOutboxEventFetcher = (
  topics: ReadonlyArray<TopicConfig>
): Effect.Effect<EventFetcher<string, SqlError, never>, never, SqlClient.SqlClient> =>
  Effect.gen(function* () {
    const fetchers = new Map<string, EventFetcher<string, SqlError, never>>();
    for (const topicConfig of topics) {
      fetchers.set(topicConfig.topic, yield* makeSqlEventFetcher<string>(topicConfig));
    }

    const fetchEvents = (
      key: string,
      lastPosition: bigint,
      batchSize: number
    ): Effect.Effect<ReadonlyArray<StoredEvent>, SqlError, never> => {
      const { topic } = fromKey(key);
      const fetcher = fetchers.get(topic);
      return fetcher
        ? fetcher.fetchEvents(key, lastPosition, batchSize)
        : Effect.die(new Error(`Unknown topic: ${topic}`));
    };

    return { fetchEvents };
  });
