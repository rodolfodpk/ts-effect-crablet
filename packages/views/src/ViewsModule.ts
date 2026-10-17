import { Effect, Stream } from "effect";
import { SqlClient } from "effect/sql";
import { PgClient } from "@effect/sql-pg";
import { EVENTS_CHANNEL, Wakeups } from "@crablet/eventstore";
import { tryAcquireGlobalLeader, VIEWS_LOCK_KEY } from "@crablet/eventstore/Leader";
import { wakeupStream } from "@crablet/eventstore/Listen";
import { holdSessionOnce, sessionPg, sessionSql } from "@crablet/eventstore/SessionClients";
import { makeEventProcessor, type EventProcessorHandle } from "@crablet/event-poller";
import { resolvePollingConfig, type ProcessorConfig } from "@crablet/event-poller/ProcessorConfig";
import { makePostgresProgressTracker } from "@crablet/event-poller/PostgresProgressTracker";
import { makeSqlEventFetcher } from "@crablet/event-poller/SqlEventFetcher";
import { VIEW_PROGRESS_CHANNEL } from "./ViewProgress.ts";
import { defaultInstanceId } from "@crablet/event-poller/InstanceId";
import type { ViewProjector } from "./ViewProjector.ts";
import type { ViewSubscription } from "./ViewSubscription.ts";
import type { ViewsConfig } from "./ViewsConfig.ts";
import { makeViewEventHandler } from "./internal/ViewEventHandler.ts";
import { makeViewProcessorConfigs } from "./internal/ViewProcessorConfig.ts";

export interface ViewsDeps {
  // Optional: what is left out takes its value from `defaultPollingConfig` (ADR-0030).
  readonly config?: ViewsConfig;
  readonly projectors: ReadonlyArray<ViewProjector>;
  readonly subscriptions: ReadonlyArray<ViewSubscription>;
  readonly instanceId?: string;
}

// Views-module-specific wiring only. The generic scheduling/leader-election/backoff engine itself lives in
// @crablet/event-poller and is reused as-is; this is the adapter layer
// assembling the module-specific handler/progress-tracker/configs (and the shared SQL fetcher) and handing them, plus
// the shared VIEWS_LOCK_KEY and EVENTS_CHANNEL, to that engine.
export const makeViewsProcessor = (
  deps: ViewsDeps
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

    const progressTracker = yield* makePostgresProgressTracker<string>({
      tableName: "crablet_view_progress",
      idColumn: "view_name",
      notifyChannel: VIEW_PROGRESS_CHANNEL
    });
    const fetcher = yield* makeSqlEventFetcher();
    const handler = makeViewEventHandler(deps.projectors);
    const configs = makeViewProcessorConfigs(deps.config, deps.subscriptions);
    const subscriptionByViewName = new Map(deps.subscriptions.map((s) => [s.viewName, s] as const));

    const wakeups = yield* Effect.service(Wakeups);
    const countSession = yield* holdSessionOnce("the views module", wakeups === "off" ? 1 : 2);

    return yield* makeEventProcessor({
      configs,
      leaderRetryIntervalMs: resolvePollingConfig(deps.config).leaderElectionRetryIntervalMs,
      fetcher,
      handler,
      progressTracker,
      // Safe: `configs` above is built 1:1 from `deps.subscriptions`, so every config.processorId
      // this gets called with is guaranteed to be a key in subscriptionByViewName.
      selectionOf: (config) => subscriptionByViewName.get(config.processorId)!,
      instanceId: deps.instanceId ?? defaultInstanceId(),
      // The first attempt at the lock marks that the module has started: count what it keeps in the session pool for good (its lock, and its LISTEN when wake-ups are on).
      acquireLeader: Effect.andThen(countSession, tryAcquireGlobalLeader(sessionSql_, VIEWS_LOCK_KEY)),
      // A view's writes are in this database, so its batch and its cursor commit together (see EventProcessorDeps.atomically).
      atomically: (effect) => sql.withTransaction(effect),
      wakeupStream: wakeups === "off" ? Stream.never : wakeupStream(sessionPg_, EVENTS_CHANNEL)
    });
  });
