import { Effect, Stream } from "effect";
import { SqlClient } from "effect/sql";
import { PgClient } from "@effect/sql-pg";
import { EVENTS_CHANNEL } from "@crablet/eventstore";
import { tryAcquireGlobalLeader, OUTBOX_LOCK_KEY } from "@crablet/eventstore/Leader";
import { wakeupStream } from "@crablet/eventstore/Listen";
import { sessionPg, sessionSql } from "@crablet/eventstore/SessionClients";
import { makeEventProcessor, type EventProcessorHandle } from "@crablet/event-poller";
import type { ProcessorConfig } from "@crablet/event-poller/ProcessorConfig";
import { defaultInstanceId } from "@crablet/event-poller/InstanceId";
import type { OutboxPublisher } from "./OutboxPublisher.ts";
import type { TopicConfig } from "./TopicConfig.ts";
import type { OutboxConfig } from "./OutboxConfig.ts";
import { makeOutboxProgressTracker } from "./internal/OutboxProgressTracker.ts";
import { makeOutboxEventFetcher } from "./internal/OutboxEventFetcher.ts";
import { makeOutboxEventHandler } from "./internal/OutboxEventHandler.ts";
import { makeOutboxProcessorConfigs } from "./internal/OutboxProcessorConfig.ts";
import * as TopicPublisherPair from "./TopicPublisherPair.ts";

export interface OutboxDeps {
  readonly config: OutboxConfig;
  readonly topics: ReadonlyArray<TopicConfig>;
  readonly publishers: ReadonlyArray<OutboxPublisher>;
  readonly instanceId?: string;
}

// Outbox-module-specific wiring only. Leadership is a single module-wide lock (OUTBOX_LOCK_KEY)
// shared by one EventProcessor handling every (topic, publisher) pair - the same single-leader model
// views uses - so this reuses @crablet/event-poller's generic engine as-is.
export const makeOutboxProcessor = (
  deps: OutboxDeps
): Effect.Effect<
  EventProcessorHandle<ProcessorConfig<string>, string>,
  never,
  SqlClient.SqlClient | PgClient.PgClient
> =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    // The leader's lock and LISTEN: the session clients when the application provides them (behind a pooler in transaction mode), else the ones above.
    const sessionSql_ = yield* sessionSql;
    const sessionPg_ = yield* sessionPg;
    const instanceId = deps.instanceId ?? defaultInstanceId();

    const progressTracker = yield* makeOutboxProgressTracker(instanceId);
    const fetcher = yield* makeOutboxEventFetcher(deps.topics);
    const handler = makeOutboxEventHandler(deps.publishers);
    const configs = makeOutboxProcessorConfigs(deps.config, deps.topics);
    const topicByName = new Map(deps.topics.map((t) => [t.topic, t] as const));

    return yield* makeEventProcessor({
      configs,
      fetcher,
      handler,
      progressTracker,
      // Safe: `configs` is built 1:1 from `deps.topics`' publisher assignments, so every
      // config.processorId decodes to a topic that's guaranteed to be a key in topicByName.
      selectionOf: (config) => topicByName.get(TopicPublisherPair.fromKey(config.processorId).topic)!,
      instanceId,
      acquireLeader: tryAcquireGlobalLeader(sessionSql_, OUTBOX_LOCK_KEY),
      wakeupStream: deps.config.listenForWakeups === false ? Stream.never : wakeupStream(sessionPg_, EVENTS_CHANNEL)
    });
  });
