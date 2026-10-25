import { Effect, type Scope, Stream } from "effect";
import { SqlClient } from "effect/sql";
import { PgClient } from "@effect/sql-pg";
import { EVENTS_CHANNEL, Wakeups } from "@crablet/eventstore";
import { tryAcquireGlobalLeader, OUTBOX_LOCK_KEY, type LeaderOptions } from "@crablet/eventstore/Leader";
import { wakeupStream } from "@crablet/eventstore/Listen";
import { holdSessionOnce, sessionPg, sessionSql } from "@crablet/eventstore/SessionClients";
import { makeEventProcessor, type EventProcessorHandle, type ProcessorHandle } from "@crablet/event-poller";
import { resolvePollingConfig, type ProcessorConfig } from "@crablet/event-poller/ProcessorConfig";
import { defaultInstanceId } from "@crablet/event-poller/InstanceId";
import { makeSqlEventFetcher } from "@crablet/event-poller/SqlEventFetcher";
import type { TopicConfig } from "./TopicConfig.ts";
import { defaultPublishTimeoutMs, type OutboxConfig } from "./OutboxConfig.ts";
import { makeOutboxProgressTracker } from "./internal/OutboxProgressTracker.ts";
import { makeOutboxEventHandler } from "./internal/OutboxEventHandler.ts";
import { makeOutboxProcessorConfigs, publishersOf } from "./internal/OutboxProcessorConfig.ts";
import * as TopicPublisherPair from "./TopicPublisherPair.ts";

export interface OutboxDeps {
  // Optional: what is left out takes its value from `defaultPollingConfig` (ADR-0030).
  readonly config?: OutboxConfig;
  // The topics, each built with `defineTopic(...)`. The publishers are theirs: the processor runs the publishers its topics name.
  readonly topics: ReadonlyArray<TopicConfig>;
  readonly instanceId?: string;
  // How the module's leader checks its lock and how long the server keeps a silent leader's session (`serverIdleTimeout`, ADR-0045). Default: the
  // defaults of `LeaderOptions`.
  readonly leader?: LeaderOptions;
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
    const fetcher = yield* makeSqlEventFetcher();
    const { publishTimeoutMs, ...pollingConfig } = deps.config ?? {};
    const handler = makeOutboxEventHandler(publishersOf(deps.topics), publishTimeoutMs ?? defaultPublishTimeoutMs);
    const configs = makeOutboxProcessorConfigs(pollingConfig, deps.topics);
    const topicByName = new Map(deps.topics.map((t) => [t.topic, t] as const));

    const wakeups = yield* Effect.service(Wakeups);
    const countSession = yield* holdSessionOnce("the outbox module", wakeups === "off" ? 1 : 2);

    return yield* makeEventProcessor({
      configs,
      leaderRetryIntervalMs: resolvePollingConfig(pollingConfig).leaderElectionRetryIntervalMs,
      fetcher,
      handler,
      progressTracker,
      // Safe: `configs` is built 1:1 from `deps.topics`' publisher assignments, so every
      // config.processorId decodes to a topic that's guaranteed to be a key in topicByName.
      selectionOf: (config) => topicByName.get(TopicPublisherPair.fromKey(config.processorId).topic)!,
      instanceId,
      // The first attempt at the lock marks that the module has started: count what it keeps in the session pool for good (its lock, and its LISTEN when wake-ups are on).
      acquireLeader: Effect.andThen(countSession, tryAcquireGlobalLeader(sessionSql_, OUTBOX_LOCK_KEY, deps.leader)),
      wakeupStream: wakeups === "off" ? Stream.never : wakeupStream(sessionPg_, EVENTS_CHANNEL)
    });
  });

// Builds the processor and starts it, owned by the Scope: it runs until the scope closes, and closing it stops the loops and releases the
// leader lock. What an application uses. `makeOutboxProcessor` builds without starting (a handle for status, a test that drives `start`/`stop` itself).
export const startOutboxProcessor = (deps: OutboxDeps): Effect.Effect<ProcessorHandle, never, SqlClient.SqlClient | PgClient.PgClient | Scope.Scope> =>
  Effect.tap(makeOutboxProcessor(deps), (handle) => handle.service.startScoped);
