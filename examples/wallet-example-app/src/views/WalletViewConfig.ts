import { WalletBalanceView } from "./WalletBalanceViewProjector.ts";
import { WalletSummaryView } from "./WalletSummaryViewProjector.ts";
import { WalletTransactionView } from "./WalletTransactionViewProjector.ts";
import { WalletStatementView } from "./WalletStatementViewProjector.ts";

// The wallet's views, for the processor. Each reads any of the wallet tags (`anyOfTags` in its definition); its event types come from its handlers.
export const walletViews = [WalletBalanceView, WalletTransactionView, WalletSummaryView, WalletStatementView];

// Per-view runtime settings, by name: deployment settings, kept out of the views' definitions. These match the global defaults this app also
// uses; they are here to show the mechanism.
export const walletViewOverrides = {
  "wallet-statement-view": { pollingIntervalMs: 1000, batchSize: 100 }
};
