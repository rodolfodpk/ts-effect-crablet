// The wallet-summary slice: the totals per wallet, a view the read endpoints (src/api) use.
import { WalletSummaryView } from "./WalletSummaryViewProjector.ts";

export * from "./WalletSummaryViewProjector.ts";

// What the views module runs for this slice (processes.ts).
export const walletSummaryViews = [WalletSummaryView];
