import { Effect, type Scope, Stream } from "effect";
import { SqlClient } from "effect/sql";
import { PgClient } from "@effect/sql-pg";
import { EVENTS_CHANNEL, Wakeups } from "@crablet/eventstore";
import { tryAcquireGlobalLeader, VIEWS_LOCK_KEY, type LeaderOptions } from "@crablet/eventstore/Leader";
import { wakeupStream } from "@crablet/eventstore/Listen";
import { holdSessionOnce, sessionPg, sessionSql } from "@crablet/eventstore/SessionClients";
import { checkIdleInTransactionOnce } from "@crablet/eventstore/ServerSettings";
import { makeEventProcessor, type EventProcessorHandle, type ProcessorHandle } from "@crablet/event-poller";
import { resolvePollingConfig, type ProcessorConfig } from "@crablet/event-poller/ProcessorConfig";
import { makePostgresProgressTracker } from "@crablet/event-poller/PostgresProgressTracker";
import { makeSqlEventFetcher } from "@crablet/event-poller/SqlEventFetcher";
import { VIEW_PROGRESS_CHANNEL } from "./ViewProgress.ts";
import { defaultInstanceId } from "@crablet/event-poller/InstanceId";
import type { ViewProjector } from "./ViewProjector.ts";
import type { ViewSubscription } from "./ViewSubscription.ts";
import type { ViewsConfig } from "./ViewsConfig.ts";
import { withOverridesByName, type ProcessorRuntimeOverrides } from "@crablet/event-poller/ProcessorRuntimeOverrides";
import { makeViewEventHandler } from "./internal/ViewEventHandler.ts";
import { makeViewProcessorConfigs } from "./internal/ViewProcessorConfig.ts";

// What the processor needs of a view: `defineView(...)`'s result has it.
export interface RunnableView {
  readonly name: string;
  readonly projector: Effect.Effect<ViewProjector<unknown>, never, SqlClient.SqlClient>;
  readonly subscription: () => ViewSubscription;
}

export interface ViewsDeps {
  // Optional: what is left out takes its value from `defaultPollingConfig` (ADR-0030).
  readonly config?: ViewsConfig;
  // The views, each built with `defineView(...).on(...)`.
  readonly views: ReadonlyArray<RunnableView>;
  // Per-view polling, batch and backoff, by view name: deployment settings, kept out of the view's definition.
  readonly overrides?: Readonly<Record<string, ProcessorRuntimeOverrides>>;
  readonly instanceId?: string;
  // How the module's leader checks its lock and how long the server keeps a silent leader's session (`serverIdleTimeout`, ADR-0045). Default: the
  // defaults of `LeaderOptions`.
  readonly leader?: LeaderOptions;
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
    const projectors: Array<ViewProjector> = [];
    for (const view of deps.views) projectors.push(yield* view.projector);
    const subscriptions = withOverridesByName("views", deps.views.map((v) => v.subscription()), (s) => s.viewName, deps.overrides ?? {});
    const handler = makeViewEventHandler(projectors);
    const configs = makeViewProcessorConfigs(deps.config, subscriptions);
    const subscriptionByViewName = new Map(subscriptions.map((s) => [s.viewName, s] as const));

    const wakeups = yield* Effect.service(Wakeups);
    const started = Effect.andThen(yield* holdSessionOnce("the views module"), checkIdleInTransactionOnce(sql));

    return yield* makeEventProcessor({
      configs,
      leaderRetryIntervalMs: resolvePollingConfig(deps.config).leaderElectionRetryIntervalMs,
      fetcher,
      handler,
      progressTracker,
      // Safe: `configs` above is built 1:1 from `subscriptions`, so every config.processorId
      // this gets called with is guaranteed to be a key in subscriptionByViewName.
      selectionOf: (config) => subscriptionByViewName.get(config.processorId)!,
      instanceId: deps.instanceId ?? defaultInstanceId(),
      // The first attempt at the lock marks that the module has started: the process's one lock session is counted by the first module (its LISTEN is on the process's LISTEN connection, not in the pool); and it checks, once per process, that the server ends a vanished pod's transaction (ServerSettings).
      acquireLeader: Effect.andThen(started, tryAcquireGlobalLeader(sessionSql_, VIEWS_LOCK_KEY, deps.leader)),
      // A view's writes are in this database, so its batch and its cursor commit together (see EventProcessorDeps.atomically).
      atomically: (effect) => sql.withTransaction(effect),
      wakeupStream: wakeups === "off" ? Stream.never : wakeupStream(sessionPg_, EVENTS_CHANNEL)
    });
  });

// Builds the processor and starts it, owned by the Scope: it runs until the scope closes, and closing it stops the loops and releases the
// leader lock. What an application uses. `makeViewsProcessor` builds without starting (a handle for status, a test that drives `start`/`stop` itself).
export const startViewsProcessor = (deps: ViewsDeps): Effect.Effect<ProcessorHandle, never, SqlClient.SqlClient | PgClient.PgClient | Scope.Scope> =>
  Effect.tap(makeViewsProcessor(deps), (handle) => handle.service.startScoped);
