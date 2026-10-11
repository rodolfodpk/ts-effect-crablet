import type { ViewSubscription } from "@crablet/views/ViewSubscription";
import * as WalletTags from "../domain/WalletTags.ts";
import { WalletBalanceView } from "./WalletBalanceViewProjector.ts";
import { WalletSummaryView } from "./WalletSummaryViewProjector.ts";
import { WalletTransactionView } from "./WalletTransactionViewProjector.ts";
import { WalletStatementView } from "./WalletStatementViewProjector.ts";

// The 4 ViewSubscriptions, all sharing one anyOfTags filter (any of wallet_id/from_wallet_id/
// to_wallet_id present).
const SHARED_ANY_OF_TAGS = new Set([WalletTags.WALLET_ID, WalletTags.FROM_WALLET_ID, WalletTags.TO_WALLET_ID]);

// The event types of each subscription come from the handlers of its view (`defineView(...).on(...)`), so they cannot drift from what the view does.
export const walletBalanceViewSubscription: ViewSubscription = WalletBalanceView.subscription({ anyOfTags: SHARED_ANY_OF_TAGS });

// #region subscription
export const walletTransactionViewSubscription: ViewSubscription = WalletTransactionView.subscription({ anyOfTags: SHARED_ANY_OF_TAGS });
// #endregion subscription

export const walletSummaryViewSubscription: ViewSubscription = WalletSummaryView.subscription({ anyOfTags: SHARED_ANY_OF_TAGS });

// Own per-subscription runtime overrides (pollingIntervalMs(1000)/batchSize(100)) - redundant
// with the global defaults this app also uses, but demonstrates the override mechanism.
export const walletStatementViewSubscription: ViewSubscription = WalletStatementView.subscription({
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
