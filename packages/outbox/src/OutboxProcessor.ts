// The outbox processor itself: build it (`makeOutboxProcessor`) or build and start it (`startOutboxProcessor`). Internal (`crablet.internal`): an application
// runs the module through `@crablet/app` (`Outbox.module(...)`); the package's tests and the module build on this.
import { Effect, type Scope, Stream } from "effect";
import { SqlClient } from "effect/sql";
import type { PgClient } from "@effect/sql-pg";
import { EVENTS_CHANNEL, Wakeups } from "@crablet/eventstore";
import { tryAcquireGlobalLeader, type LeaderOptions } from "@crablet/eventstore/Leader";
import { wakeupStream } from "@crablet/eventstore/Listen";
import { holdSessionOnce, sessionPg, sessionSql } from "@crablet/eventstore/SessionClients";
import { checkIdleInTransactionOnce } from "@crablet/eventstore/ServerSettings";
import { makeEventProcessor, type ProcessorHandle } from "@crablet/event-poller";
import type { EventHandler } from "@crablet/event-poller/EventHandler";
import { resolvePollingConfig } from "@crablet/event-poller/ProcessorConfig";
import { defaultInstanceId } from "@crablet/event-poller/InstanceId";
import { makeSqlEventFetcher } from "@crablet/event-poller/SqlEventFetcher";
import type { PublisherNamesOf, TopicConfig } from "./TopicConfig.ts";
import { OutboxPublishers, type OutboxPublisher } from "./OutboxPublisher.ts";
import { defaultPublishTimeoutMs, type OutboxConfig } from "./OutboxConfig.ts";
import { makeOutboxProgressTracker } from "./internal/OutboxProgressTracker.ts";
import { makeOutboxEventHandler } from "./internal/OutboxEventHandler.ts";
import { makeOutboxProcessorConfigs } from "./internal/OutboxProcessorConfig.ts";
import * as TopicPublisherPair from "./TopicPublisherPair.ts";

// The module's advisory lock: one leader per database at a time (ADR-0022). Its value never changes: in a rolling deploy, old and new versions take the
// same lock, so they never lead together. The key belongs to the module, not to the event store, so a new kind of module needs no change there.
export const OUTBOX_LOCK_KEY = 4856221667890123456n;

export interface OutboxDeps {
  // Optional: what is left out takes its value from `defaultPollingConfig` (ADR-0030).
  readonly config?: OutboxConfig | undefined;
  // The topics, each built with `defineTopic(...)`. They name their publishers; the publishers themselves are given where the processor starts.
  readonly topics: ReadonlyArray<TopicConfig>;
  readonly instanceId?: string | undefined;
  // How the module's leader checks its lock and how long the server keeps a silent leader's session (`serverIdleTimeout`, ADR-0045). Default: the
  // defaults of `LeaderOptions`.
  readonly leader?: LeaderOptions | undefined;
}

// Outbox-module-specific wiring only. Leadership is a single module-wide lock (OUTBOX_LOCK_KEY)
// shared by one EventProcessor handling every (topic, publisher) pair - the same single-leader model
// views uses - so this reuses @crablet/event-poller's generic engine as-is.
// Built needing only the SQL client (decision V1): a handle that is not running is read and controlled through the database. Running needs the `PgClient`
// its wake-ups LISTEN on and the publishers its topics name, given where it starts.
export type OutboxRunRequirements = PgClient.PgClient | OutboxPublishers;

export const makeOutboxProcessor = (
  deps: OutboxDeps
): Effect.Effect<ProcessorHandle<OutboxRunRequirements>, never, SqlClient.SqlClient> =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    // The leader's lock and LISTEN: the session clients when the application provides them (behind a pooler in transaction mode), else the ones above.
    const sessionSql_ = yield* sessionSql;
    const instanceId = deps.instanceId ?? defaultInstanceId();

    const progressTracker = yield* makeOutboxProgressTracker(instanceId);
    const fetcher = yield* makeSqlEventFetcher();
    const { publishTimeoutMs, ...pollingConfig } = deps.config ?? {};
    const handler: EventHandler<string, unknown, OutboxRunRequirements> = makeOutboxEventHandler(publishTimeoutMs ?? defaultPublishTimeoutMs);
    const configs = makeOutboxProcessorConfigs(pollingConfig, deps.topics);
    const topicByName = new Map(deps.topics.map((t) => [t.topic, t] as const));

    const wakeups = yield* Effect.service(Wakeups);
    const started = Effect.andThen(yield* holdSessionOnce("the outbox module"), checkIdleInTransactionOnce(sql));

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
      // The first attempt at the lock marks that the module has started: the process's one lock session is counted by the first module (its LISTEN is on the process's LISTEN connection, not in the pool); and it checks, once per process, that the server ends a vanished pod's transaction (ServerSettings).
      acquireLeader: Effect.andThen(started, tryAcquireGlobalLeader(sessionSql_, OUTBOX_LOCK_KEY, deps.leader)),
      wakeupStream: wakeups === "off" ? Stream.never : Stream.unwrap(Effect.map(sessionPg, (pg) => wakeupStream(pg, EVENTS_CHANNEL)))
    });
  });

// One publisher for each name the topics give. The names must be known to the compiler (literals, as `defineTopic` keeps them): with names typed
// `string` (topics built at run time, or annotated `TopicConfig[]`) any record would do, so that does not compile.
export type PublishersFor<T extends ReadonlyArray<TopicConfig>> = { readonly [K in PublisherNamesOf<T>]: OutboxPublisher<unknown> } &
  (string extends PublisherNamesOf<T> ? { readonly error: "the topics' publisher names must be literal: declare them with defineTopic, without widening to TopicConfig[]" } : unknown);

// What starting the outbox takes besides its declaration: one publisher for each name its topics give (a name with no publisher does not compile).
export interface OutboxStartDeps<T extends ReadonlyArray<TopicConfig>> extends OutboxDeps {
  readonly topics: T;
  readonly publishers: PublishersFor<T>;
}

// Every publisher name the topics give has a publisher in the ones this process runs with, or the processor does not start: a missing one fails the start,
// naming it, instead of failing every poll of its pair. The compiler checks this where the names are literal; this checks it where they are not (a
// hand-built `OutboxPublishers`, publishers given for other topics).
const requirePublishers = (topics: ReadonlyArray<TopicConfig>): Effect.Effect<void, never, OutboxPublishers> =>
  Effect.flatMap(Effect.service(OutboxPublishers), (given) => {
    const missing = [...new Set(topics.flatMap((t) => t.publishers.map((p) => p.publisher)))].filter((name) => !Object.hasOwn(given, name));
    return missing.length === 0
      ? Effect.void
      : Effect.die(new Error(`outbox: no publisher given for ${missing.map((n) => `"${n}"`).join(", ")}, named by the topics; give one per name (Outbox.publishers)`));
  });

// Starts a built handle once its publishers are checked.
export const startChecked = (handle: ProcessorHandle<OutboxRunRequirements>, topics: ReadonlyArray<TopicConfig>) =>
  Effect.andThen(requirePublishers(topics), handle.service.startScoped);

// Builds the processor and starts it with its publishers, owned by the Scope: it runs until the scope closes, and closing it stops the loops and
// releases the leader lock. What an application uses. `makeOutboxProcessor` builds without starting (a handle for status, a test that drives
// `start`/`stop` itself and provides `OutboxPublishers`).
export const startOutboxProcessor = <const T extends ReadonlyArray<TopicConfig>>(
  deps: OutboxStartDeps<T>
): Effect.Effect<ProcessorHandle<OutboxRunRequirements>, never, SqlClient.SqlClient | PgClient.PgClient | Scope.Scope> =>
  Effect.tap(makeOutboxProcessor(deps), (handle) => Effect.provideService(startChecked(handle, deps.topics), OutboxPublishers, deps.publishers));
