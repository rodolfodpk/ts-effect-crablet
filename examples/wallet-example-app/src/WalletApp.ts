import { timingSafeEqual } from "node:crypto";
import { Duration, Effect, Layer, Redacted, type Scope } from "effect";
import * as Schema from "effect/Schema";
import { SqlClient } from "effect/sql";
import { PgClient } from "@effect/sql-pg";
import { HttpApi, HttpApiBuilder } from "effect/http-api";
import { EventStore } from "@crablet/eventstore";
import { CommandAuditStore } from "@crablet/eventstore/CommandAuditStore";
import { CommandExecutor } from "@crablet/commands";
import type { ProcessorHandle } from "@crablet/event-poller";
import { defaultInstanceId } from "@crablet/event-poller/InstanceId";
import { monitorProcessors } from "@crablet/event-poller/MonitorProcessors";
import { makeViewsProcessor, startViewsProcessor } from "@crablet/views";
import { makeViewManagementService } from "@crablet/views/ViewManagementService";
import { ViewProgressHubLive } from "@crablet/views/ViewProgressHub";
import { makeAutomationsProcessor, startAutomationsProcessor } from "@crablet/automations";
import { makeAutomationManagementService } from "@crablet/automations/AutomationManagementService";
import { makeOutboxProcessor, startOutboxProcessor } from "@crablet/outbox";
import { makeOutboxManagementService } from "@crablet/outbox/OutboxManagementService";
import { defineTopic } from "@crablet/outbox/TopicConfig";
import { makeLogPublisher, type OutboxPublisher } from "@crablet/outbox/OutboxPublisher";
import { makeCommandApiGroup, withApiInfo, type Implementations } from "@crablet/commands-http";
import { processorsGroup } from "@crablet/processors-http";
import { authorizationFrom } from "@crablet/processors-http/Authorization";
import { makeProcessorsApiGroupLive, type ProcessorSource } from "@crablet/processors-http/ProcessorsApiLive";
import { apiDocsLayer, apiLayerOptions } from "@crablet/commands-http/ApiDescription";
import { makeCommandApiGroupLive } from "@crablet/commands-http/CommandApiLive";
import { walletViewOverrides, walletViews } from "./views/WalletViewConfig.ts";
import { allRoles, type Role, type Roles } from "./roles.ts";
import { defaultPolling, type Polling } from "./polling.ts";
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

// The three processors of the wallet. Every handle exists whatever the roles (the admin API reads status through them); only the modules named in
// `roles` are started.
export interface BackgroundProcessors {
  // The roles this process runs.
  readonly roles: Roles;
  readonly viewsHandle: ProcessorHandle;
  readonly automationsHandle: ProcessorHandle;
  readonly outboxHandle: ProcessorHandle;
}

export interface BackgroundProcessorsOptions {
  readonly instanceId?: string;
  // Where the outbox publishes. Default: the log publisher the real app uses; outbox-e2e.test.ts passes a capturing one.
  readonly outboxPublishers?: ReadonlyArray<OutboxPublisher>;
  // The roles to start (ADR-0022). Default: all of them, one process.
  readonly roles?: Roles;
  // How often the processors poll and how far they back off when idle (WALLET_POLL_MS, WALLET_BACKOFF_MAX_SECONDS).
  readonly polling?: Polling;
}

// Builds the three background processors (views, automations, outbox) and starts those of the roles, owned by the Scope: closing it stops them
// and releases their leader locks (the other instances take over at once), so close it before the connection pool.
export const startBackgroundProcessors = (
  options: BackgroundProcessorsOptions = {}
): Effect.Effect<
  BackgroundProcessors,
  never,
  SqlClient.SqlClient | PgClient.PgClient | EventStore | CommandAuditStore | CommandExecutor | Scope.Scope
> =>
  Effect.gen(function* () {
    const { instanceId = defaultInstanceId(), outboxPublishers = [makeLogPublisher()], roles = allRoles, polling = defaultPolling } = options;
    // A role that is not started still has its handle: building one opens no connection and runs no loop.
    // #region views-processor
    const views = { config: polling, views: walletViews, overrides: walletViewOverrides, instanceId };
    const viewsHandle = yield* (roles.has("views") ? startViewsProcessor(views) : makeViewsProcessor(views));
    // #endregion views-processor

    // #region automations-processor
    const automations = { config: polling, automations: [walletOpenedAutomation], instanceId };
    const automationsHandle = yield* (roles.has("automations") ? startAutomationsProcessor(automations) : makeAutomationsProcessor(automations));
    // #endregion automations-processor

    const outbox = {
      config: polling,
      topics: [
        defineTopic("wallet-events", {
          anyOfTags: new Set(["wallet_id", "from_wallet_id", "to_wallet_id"]),
          publishers: outboxPublishers
        })
      ],
      instanceId
    };
    const outboxHandle = yield* (roles.has("outbox") ? startOutboxProcessor(outbox) : makeOutboxProcessor(outbox));

    return { roles, viewsHandle, automationsHandle, outboxHandle };
  });

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
// whose leader has died still shows its lag growing (docs/guides/operate/monitor-it.md#are-the-consumers-keeping-up).
// #region monitor-processors
export const monitorBackgroundProcessors = (
  processors: BackgroundProcessors,
  instanceId: string = defaultInstanceId()
): Effect.Effect<void, never, SqlClient.SqlClient | Scope.Scope> =>
  Effect.gen(function* () {
    // Only the modules this process runs: the gauges come from the roles that have a loop to sample (ADR-0022, decision 4).
    const sources = (yield* processorSources(processors)).filter((s) => processors.roles.has(s.kind as Role));
    if (sources.length > 0) yield* Effect.forkScoped(monitorProcessors(sources.map((s) => s.service), { instanceId }));
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
