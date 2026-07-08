import { viewSubscriptionOf, type ViewSubscription } from "@crablet/views/ViewSubscription";
import * as WalletTags from "../domain/WalletTags.ts";
import * as WalletEvents from "../domain/events/WalletEvents.ts";

// Port of com.crablet.wallet.view.config.WalletViewConfig - the 4 ViewSubscriptions, all sharing
// one anyOfTags filter (any of wallet_id/from_wallet_id/to_wallet_id present), same as Java's own
// config. Deliberately includes WalletClosed in balance/summary's own eventTypes (see this port's
// plan for the discrepancy writeup: Java's own subscriptions omit it, making their projectors'
// own delete-on-close switch branches dead code).
const SHARED_ANY_OF_TAGS = new Set([WalletTags.WALLET_ID, WalletTags.FROM_WALLET_ID, WalletTags.TO_WALLET_ID]);

export const walletBalanceViewSubscription: ViewSubscription = viewSubscriptionOf("wallet-balance-view", {
  eventTypes: new Set([
    WalletEvents.WALLET_OPENED,
    WalletEvents.DEPOSIT_MADE,
    WalletEvents.WITHDRAWAL_MADE,
    WalletEvents.MONEY_TRANSFERRED,
    WalletEvents.WALLET_CLOSED
  ]),
  anyOfTags: SHARED_ANY_OF_TAGS
});

export const walletTransactionViewSubscription: ViewSubscription = viewSubscriptionOf("wallet-transaction-view", {
  eventTypes: new Set([WalletEvents.DEPOSIT_MADE, WalletEvents.WITHDRAWAL_MADE, WalletEvents.MONEY_TRANSFERRED]),
  anyOfTags: SHARED_ANY_OF_TAGS
});

export const walletSummaryViewSubscription: ViewSubscription = viewSubscriptionOf("wallet-summary-view", {
  eventTypes: new Set([
    WalletEvents.WALLET_OPENED,
    WalletEvents.DEPOSIT_MADE,
    WalletEvents.WITHDRAWAL_MADE,
    WalletEvents.MONEY_TRANSFERRED,
    WalletEvents.WALLET_CLOSED
  ]),
  anyOfTags: SHARED_ANY_OF_TAGS
});

// Own per-subscription runtime overrides, matching Java's own WalletStatementViewProjector
// subscription (pollingIntervalMs(1000)/batchSize(100)) - redundant with the global defaults this
// app also uses, but demonstrates the override mechanism the same way Java's config does.
export const walletStatementViewSubscription: ViewSubscription = viewSubscriptionOf("wallet-statement-view", {
  eventTypes: new Set([
    WalletEvents.WALLET_STATEMENT_OPENED,
    WalletEvents.WALLET_STATEMENT_CLOSED,
    WalletEvents.DEPOSIT_MADE,
    WalletEvents.WITHDRAWAL_MADE,
    WalletEvents.MONEY_TRANSFERRED
  ]),
  anyOfTags: SHARED_ANY_OF_TAGS,
  pollingIntervalMs: 1000,
  batchSize: 100
});

export const walletViewSubscriptions: ReadonlyArray<ViewSubscription> = [
  walletBalanceViewSubscription,
  walletTransactionViewSubscription,
  walletSummaryViewSubscription,
  walletStatementViewSubscription
];
