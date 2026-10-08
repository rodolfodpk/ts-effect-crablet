import { timingSafeEqual } from "node:crypto";
import { Duration, Effect, Layer, Redacted, type Scope } from "effect";
import * as Schema from "effect/Schema";
import { SqlClient } from "effect/sql";
import { PgClient } from "@effect/sql-pg";
import { HttpApi, HttpApiBuilder } from "effect/http-api";
import { EventStore } from "@crablet/eventstore";
import { CommandAuditStore } from "@crablet/eventstore/CommandAuditStore";
import { CommandExecutor } from "@crablet/commands";
import type { EventProcessorHandle } from "@crablet/event-poller";
import type { ProcessorConfig } from "@crablet/event-poller/ProcessorConfig";
import { defaultInstanceId } from "@crablet/event-poller/InstanceId";
import { monitorProcessors } from "@crablet/event-poller/MonitorProcessors";
import { makeViewsProcessor } from "@crablet/views";
import { makeViewManagementService } from "@crablet/views/ViewManagementService";
import type { ViewsConfig } from "@crablet/views/ViewsConfig";
import { ViewProgressHubLive } from "@crablet/views/ViewProgressHub";
import { makeAutomationsProcessor } from "@crablet/automations";
import { makeAutomationManagementService } from "@crablet/automations/AutomationManagementService";
import type { AutomationsConfig } from "@crablet/automations/AutomationsConfig";
import { makeOutboxProcessor } from "@crablet/outbox";
import { makeOutboxManagementService } from "@crablet/outbox/OutboxManagementService";
import type { OutboxConfig } from "@crablet/outbox/OutboxConfig";
import { topicConfigOf } from "@crablet/outbox/TopicConfig";
import { makeLogPublisher, type OutboxPublisher } from "@crablet/outbox/OutboxPublisher";
import { makeCommandApiGroup, withApiInfo, type Implementations } from "@crablet/commands-http";
import { processorsGroup } from "@crablet/processors-http";
import { authorizationFrom } from "@crablet/processors-http/Authorization";
import { makeProcessorsApiGroupLive, type ProcessorSource } from "@crablet/processors-http/ProcessorsApiLive";
import { apiDocsLayer, apiLayerOptions } from "@crablet/commands-http/ApiDescription";
import { makeCommandApiGroupLive } from "@crablet/commands-http/CommandApiLive";
import { makeWalletBalanceViewProjector } from "./views/WalletBalanceViewProjector.ts";
import { makeWalletTransactionViewProjector } from "./views/WalletTransactionViewProjector.ts";
import { makeWalletSummaryViewProjector } from "./views/WalletSummaryViewProjector.ts";
import { makeWalletStatementViewProjector } from "./views/WalletStatementViewProjector.ts";
import { walletViewSubscriptions } from "./views/WalletViewConfig.ts";
import { walletOpenedAutomation } from "./automations/WalletOpenedAutomation.ts";
import { walletQueryGroup } from "./api/WalletQueryApi.ts";
import { makeWalletQueryApiLive } from "./api/WalletQueryApiLive.ts";
import { OpenWallet } from "./domain/commands/OpenWalletCommand.ts";
import { walletContracts } from "./domain/WalletContracts.ts";
import { Deposit } from "./domain/commands/DepositCommand.ts";
import { Withdraw } from "./domain/commands/WithdrawCommand.ts";
import { TransferMoney } from "./domain/commands/TransferMoneyCommand.ts";
import { CloseWallet } from "./domain/commands/CloseWalletCommand.ts";

export interface WalletAppConfig {
  readonly basePath?: string;
  readonly instanceId?: string;
  // Where the OpenAPI document is served (default "/openapi.json"; false = none) and an optional docs page.
  readonly openApiPath?: string | false;
  readonly docs?: { readonly ui: "scalar" | "swagger"; readonly path?: string };
}

const defaultViewsConfig: ViewsConfig = {
  enabled: true,
  pollingIntervalMs: 1000,
  batchSize: 100,
  backoffEnabled: true,
  backoffThreshold: 3,
  backoffMultiplier: 2,
  backoffMaxSeconds: 120,
  leaderElectionRetryIntervalMs: 5_000,
  maxErrors: 10
};

const defaultAutomationsConfig: AutomationsConfig = {
  enabled: true,
  pollingIntervalMs: 1000,
  batchSize: 100,
  backoffEnabled: true,
  backoffThreshold: 3,
  backoffMultiplier: 2,
  backoffMaxSeconds: 120,
  leaderElectionRetryIntervalMs: 5_000,
  maxErrors: 10
};

const defaultOutboxConfig: OutboxConfig = {
  enabled: true,
  pollingIntervalMs: 1000,
  batchSize: 100,
  backoffEnabled: true,
  backoffThreshold: 3,
  backoffMultiplier: 2,
  backoffMaxSeconds: 120,
  leaderElectionRetryIntervalMs: 5_000,
  maxErrors: 10
};

// The 3 EventProcessorHandles started by startBackgroundProcessors - a caller that uses it directly (every E2E test file) must call `.service.stop` on each
// before tearing down the underlying connection pool. The entry point uses `startBackgroundProcessorsScoped` below instead, and the scope does that.
// `.service.start` forks its daemon fibers via `Effect.forkDetach` (see EventProcessor.ts's own
// primer), deliberately detached from any scope/parent fiber - so closing a Scope or disposing a
// ManagedRuntime does NOT stop them on its own; only `.service.stop`'s explicit
// `Fiber.interruptAll` does. Omitting this leaves the poll loops running forever, retrying against
// a closed pool - the hang this comment is here to prevent from recurring.
export interface BackgroundProcessors {
  readonly viewsHandle: EventProcessorHandle<ProcessorConfig<string>, string>;
  readonly automationsHandle: EventProcessorHandle<ProcessorConfig<string>, string>;
  readonly outboxHandle: EventProcessorHandle<ProcessorConfig<string>, string>;
}

// #region stop-processors
export const stopBackgroundProcessors = (processors: BackgroundProcessors): Effect.Effect<void> =>
  Effect.gen(function* () {
    yield* processors.viewsHandle.service.stop;
    yield* processors.automationsHandle.service.stop;
    yield* processors.outboxHandle.service.stop;
  });
// #endregion stop-processors

// Builds and starts the 3 background processors (views/automations/outbox). Building/providing
// their Layers alone would NOT process any events - each EventProcessorHandle's own `.service.start`
// forks the long-lived daemon fibers that actually do the work (same requirement every prior
// phase's own integration tests already had to satisfy).
export const startBackgroundProcessors = (
  instanceId: string = defaultInstanceId(),
  // Injectable for testability (outbox-e2e.test.ts swaps in a capturing test publisher instead of
  // asserting on log output) - defaults to the same makeLogPublisher() the real app uses.
  outboxPublishers: ReadonlyArray<OutboxPublisher> = [makeLogPublisher()]
): Effect.Effect<
  BackgroundProcessors,
  never,
  SqlClient.SqlClient | PgClient.PgClient | EventStore | CommandAuditStore | CommandExecutor
> =>
  Effect.gen(function* () {
    // #region views-processor
    const viewsHandle = yield* makeViewsProcessor({
      config: defaultViewsConfig,
      projectors: [
        yield* makeWalletBalanceViewProjector(),
        yield* makeWalletTransactionViewProjector(),
        yield* makeWalletSummaryViewProjector(),
        yield* makeWalletStatementViewProjector()
      ],
      subscriptions: walletViewSubscriptions,
      instanceId
    });
    yield* viewsHandle.service.start;
    // #endregion views-processor

    // #region automations-processor
    const automationsHandle = yield* makeAutomationsProcessor({
      config: defaultAutomationsConfig,
      handlers: [walletOpenedAutomation],
      instanceId
    });
    yield* automationsHandle.service.start;
    // #endregion automations-processor

    const outboxHandle = yield* makeOutboxProcessor({
      config: defaultOutboxConfig,
      topics: [
        topicConfigOf("wallet-events", {
          anyOfTags: new Set(["wallet_id", "from_wallet_id", "to_wallet_id"]),
          publishers: outboxPublishers.map((p) => p.name)
        })
      ],
      publishers: outboxPublishers,
      instanceId
    });
    yield* outboxHandle.service.start;

    return { viewsHandle, automationsHandle, outboxHandle };
  });

// The same, owned by a Scope: closing the scope stops the three processors and releases their leader locks (the others take over at once). This is what an entry point
// should use; `startBackgroundProcessors` and `stopBackgroundProcessors` are for tests and for callers that manage the lifetime themselves.
// #region start-scoped
export const startBackgroundProcessorsScoped = (
  instanceId?: string,
  outboxPublishers?: ReadonlyArray<OutboxPublisher>
): Effect.Effect<BackgroundProcessors, never, SqlClient.SqlClient | PgClient.PgClient | EventStore | CommandAuditStore | CommandExecutor | Scope.Scope> =>
  Effect.acquireRelease(startBackgroundProcessors(instanceId, outboxPublishers), stopBackgroundProcessors);
// #endregion start-scoped

// What each module's processors are for, as the admin API shows it.
const wallet = {
  "wallet-balance-view": "The balance of each wallet",
  "wallet-transaction-view": "Every transaction of each wallet, newest first",
  "wallet-summary-view": "Totals per wallet",
  "wallet-statement-view": "Monthly statements",
  "wallet-opened-welcome-notification": "Sends a welcome notification when a wallet is opened"
} as const;

// The three modules' management services, named as a client of the admin API (and the consumer gauges) sees their kinds.
// #region processor-sources
export const processorSources = (processors: BackgroundProcessors): Effect.Effect<ReadonlyArray<ProcessorSource>, never, SqlClient.SqlClient> =>
  Effect.gen(function* () {
    return [
      { kind: "views", service: yield* makeViewManagementService(processors.viewsHandle), describe: (id) => (wallet as Record<string, string>)[id] },
      { kind: "automations", service: yield* makeAutomationManagementService(processors.automationsHandle), describe: (id) => (wallet as Record<string, string>)[id] },
      { kind: "outbox", service: yield* makeOutboxManagementService(processors.outboxHandle) }
    ];
  });
// #endregion processor-sources

// Keeps the consumer gauges (lag, cursor, status) current for the three modules, for as long as the scope lives. Every instance runs it, so a processor
// whose leader has died still shows its lag growing (docs/guides/monitor-it.md#are-the-consumers-keeping-up).
// #region monitor-processors
export const monitorBackgroundProcessors = (
  processors: BackgroundProcessors,
  instanceId: string = defaultInstanceId()
): Effect.Effect<void, never, SqlClient.SqlClient | Scope.Scope> =>
  Effect.gen(function* () {
    const sources = yield* processorSources(processors);
    yield* Effect.forkScoped(monitorProcessors(sources.map((s) => s.service), { instanceId }));
  });
// #endregion monitor-processors

// The admin API over the three modules' processors (list, pause, resume, reset), behind a bearer token. It is a separate API from the wallet's, mounted
// only when the application is given a token (index.ts: WALLET_ADMIN_TOKEN): there is no admin API without one, and the server does not start a
// mounted one without an authorization. The token is compared in constant time; a real application would check its own identity provider instead.
// #region admin-api
export const makeWalletAdminApiLayer = (sources: ReadonlyArray<ProcessorSource>, token: Redacted.Redacted<string>) => {
  const adminApi = HttpApi.make("walletAdmin").add(processorsGroup);
  const expected = Buffer.from(Redacted.value(token));
  const authorization = authorizationFrom((presented) =>
    Effect.sync(() => {
      const got = Buffer.from(Redacted.value(presented));
      return got.length === expected.length && timingSafeEqual(got, expected);
    })
  );
  return HttpApiBuilder.layer(adminApi).pipe(Layer.provide(makeProcessorsApiGroupLive(adminApi, sources)), Layer.provide(authorization));
};
// #endregion admin-api

// The wallet's public write API is declared from the five CONTRACTS (domain/WalletContracts.ts), deliberately NOT SendWelcomeNotification (an
// automation-triggered internal command, not a public write API). Each contract declares its domain errors, which the API presents by their
// kind (404 / 400 / ...) with their own fields and documents in the API description. The server's side: the command built from each contract;
// a missing or extra command does not compile, and one not built from its contract is refused when the layer is built.
const walletImplementations: Implementations<typeof walletContracts> = {
  open_wallet: OpenWallet,
  deposit: Deposit,
  withdraw: Withdraw,
  transfer_money: TransferMoney,
  close_wallet: CloseWallet
};

// The app's HTTP API: commands-http's write group (one route per wallet command) + WalletQueryApi's
// hand-written reads, combined into ONE HttpApi. A function of `basePath` because the command routes live under it.
// Separate from `makeWalletApiLayer` so the API DESCRIPTION can be produced without serving anything
// (see scripts/generate-wallet-openapi.ts).
export const walletApiInfo = {
  title: "Wallet API",
  version: "1.0.0",
  description:
    "Wallet example: write commands (one route each, errors presented as application/problem+json) and read endpoints over the view tables."
} as const;

export const makeWalletApi = (basePath: `/${string}` = "/api/commands") =>
  withApiInfo(
    HttpApi.make("walletApp")
      .add(makeCommandApiGroup(basePath, walletContracts))
      .add(walletQueryGroup),
    walletApiInfo
  );

// Serves the API: the commands and reads, the OpenAPI document (at /openapi.json unless `openApiPath` says
// otherwise) and, when asked for, a documentation page.
export const makeWalletApiLayer = (config: WalletAppConfig = {}) => {
  const basePath = (config.basePath ?? "/api/commands") as `/${string}`;
  const api = makeWalletApi(basePath);

  const commandsLive = makeCommandApiGroupLive(api, walletContracts, walletImplementations, {
    basePath,
    correlationHeaderEnabled: true
  });
  const queryLive = makeWalletQueryApiLive(api);

  return Layer.merge(
    // the reads' wait is woken by the view progress hub (one database LISTEN for the process, ADR-0016) instead of polling
    HttpApiBuilder.layer(api, apiLayerOptions(config)).pipe(Layer.provide(commandsLive), Layer.provide(Layer.provide(queryLive, ViewProgressHubLive))),
    apiDocsLayer(api, config)
  );
};
