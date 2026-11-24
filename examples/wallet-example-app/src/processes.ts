import { Layer } from "effect";
import * as Crablet from "@crablet/app";
import * as Views from "@crablet/views";
import * as Automations from "@crablet/automations";
import * as Outbox from "@crablet/outbox";
import { defineTopic } from "@crablet/outbox/TopicConfig";
import { makeLogPublisher, type OutboxPublisher } from "@crablet/outbox/OutboxPublisher";
import { walletViewOverrides, walletViews } from "./views/WalletViewConfig.ts";
import { walletOpenedAutomation } from "./automations/WalletOpenedAutomation.ts";

// What each module's processors are for, as the admin API shows it.
const purposes: Readonly<Record<string, string>> = {
  "wallet-balance-view": "The balance of each wallet",
  "wallet-transaction-view": "Every transaction of each wallet, newest first",
  "wallet-summary-view": "Totals per wallet",
  "wallet-statement-view": "Monthly statements",
  "wallet-opened-welcome-notification": "Sends a welcome notification when a wallet is opened"
};
const describe = (id: string): string | undefined => purposes[id];

// The topic the outbox publishes. The publisher's name keys its progress row: it stays the one the wallet has always used.
export const walletTopics = [
  defineTopic("wallet-events", { anyOfTags: new Set(["wallet_id", "from_wallet_id", "to_wallet_id"]), publishers: ["LogPublisher"] })
];

// What each module runs: the four views with a per-view setting by name (polling and batch size are deployment settings, not part of a view), the
// welcome automation, the topic. A test that needs a module's own handle builds one from these (`makeViewsProcessor({ ...walletViewsOptions, instanceId })`).
export const walletViewsOptions = { views: walletViews, overrides: walletViewOverrides };
export const walletAutomationsOptions = { automations: [walletOpenedAutomation] };

// The wallet's three modules, declared once (ADR-0054): a plain value, which every process builds and runs the part its roles say.
// #region wallet-modules
export const walletModules = Crablet.modules(Views.module({ ...walletViewsOptions, describe }))
  .with(Automations.module({ ...walletAutomationsOptions, describe }))
  .with(Outbox.module({ topics: walletTopics }));
// #endregion wallet-modules

export interface WalletProcessesOptions extends Crablet.ProcessOptions {
  // Where the outbox publishes. Default: the log publisher the real app uses; outbox-e2e.test.ts passes a capturing one.
  readonly outboxPublisher?: OutboxPublisher | undefined;
}

// The modules the roles say, running, and all of them listed (the `Processors` service the admin API and /status read). A role that is neither `api`
// nor one of the three modules fails the layer with `UnknownRole`. Provided on top of `Crablet.layer`, it stops the modules and releases their locks
// before the pool closes.
export const walletProcesses = (roles: Crablet.Roles<"api">, options: WalletProcessesOptions = {}) => {
  const { outboxPublisher = makeLogPublisher(), ...process } = options;
  return Crablet.processorsFor(walletModules, roles, process).pipe(Layer.provide(Outbox.publishers(walletTopics, { LogPublisher: outboxPublisher })));
};
