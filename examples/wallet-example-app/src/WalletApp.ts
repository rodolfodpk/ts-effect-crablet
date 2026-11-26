import { timingSafeEqual } from "node:crypto";
import { Effect, Layer, Redacted } from "effect";
import { HttpApi } from "effect/http-api";
import { ViewProgressHubLive } from "@crablet/views/ViewProgressHub";
import { makeCommandApiGroup, withApiInfo, type Implementations } from "@crablet/commands-http";
import { authorizationFrom } from "@crablet/processors-http/Authorization";
import { adminApiLayer } from "@crablet/processors-http/AdminApiLive";
import { eventPayloadMask } from "@crablet/commands/Personal";
import * as M from "./shared/WalletModel.ts";
import { WelcomeNotificationSent } from "./slices/welcome-notification/WelcomeNotificationSent.ts";
import { serveApi } from "@crablet/commands-http/ServeApi";
import { walletQueryGroup } from "./api/WalletQueryApi.ts";
import { makeWalletQueryApiLive } from "./api/WalletQueryApiLive.ts";
import { OpenWallet } from "./slices/open-wallet/OpenWalletCommand.ts";
import { walletContracts } from "./shared/WalletContracts.ts";
import { Deposit } from "./slices/deposit/DepositCommand.ts";
import { Withdraw } from "./slices/withdraw/WithdrawCommand.ts";
import { TransferMoney } from "./slices/transfer-money/TransferMoneyCommand.ts";
import { CloseWallet } from "./slices/close-wallet/CloseWalletCommand.ts";

export interface WalletAppConfig {
  readonly basePath?: string | undefined;
  readonly instanceId?: string | undefined;
  // Where the OpenAPI document is served (default "/openapi.json"; false = none) and an optional docs page.
  readonly openApiPath?: string | false | undefined;
  readonly docs?: { readonly ui: "scalar" | "swagger"; readonly path?: string } | undefined;
}

// The admin API over the modules' processors (list, pause, resume, reset) and the event log (browse it page by page, payloads masked from the
// wallet's event definitions: personal fields redacted, unknown keys dropped, ADR-0050), behind a bearer token. It is a separate API from the wallet's, mounted
// only when the application is given a token (index.ts: WALLET_ADMIN_TOKEN): there is no admin API without one, and the server does not start a
// mounted one without an authorization. The token is compared in constant time; a real application would check its own identity provider instead.
// Every event the wallet defines: what the event log API may show the payload of.
const walletEventDefinitions = [M.WalletOpened, M.WalletClosed, M.WalletStatementOpened, M.WalletStatementClosed, M.DepositMade, M.WithdrawalMade, M.MoneyTransferred, WelcomeNotificationSent];

// #region admin-api
export const makeWalletAdminApiLayer = (token: Redacted.Redacted<string>) => {
  const expected = Buffer.from(Redacted.value(token));
  const authorization = authorizationFrom((presented) =>
    Effect.sync(() => {
      const got = Buffer.from(Redacted.value(presented));
      return got.length === expected.length && timingSafeEqual(got, expected);
    })
  );
  // the modules come from the process's `Processors` (src/processes.ts)
  return adminApiLayer({ masks: { mask: eventPayloadMask(walletEventDefinitions) } }).pipe(Layer.provide(authorization));
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

// The API's type: what the server's read group is implemented against (`HttpApiBuilder.group(api, "walletQueries", ...)`).
export type WalletApi = ReturnType<typeof makeWalletApi>;

// Serves the API: the commands and reads, the OpenAPI document (at /openapi.json unless `openApiPath` says
// otherwise) and, when asked for, a documentation page.
export const makeWalletApiLayer = (config: WalletAppConfig = {}) => {
  const basePath = (config.basePath ?? "/api/commands") as `/${string}`;
  const api = makeWalletApi(basePath);
  // the reads' wait is woken by the view progress hub (one database LISTEN for the process, ADR-0016) instead of polling
  return serveApi(api, {
    commands: { contracts: walletContracts, implementations: walletImplementations, basePath, correlationHeaderEnabled: true },
    groups: [makeWalletQueryApiLive(api)],
    openApiPath: config.openApiPath,
    docs: config.docs
  }).pipe(Layer.provide(ViewProgressHubLive));
};
