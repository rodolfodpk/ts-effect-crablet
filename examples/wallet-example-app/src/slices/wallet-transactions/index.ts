// The wallet-transactions slice: every transaction of each wallet, newest first, a view the read endpoints (src/api) use.
import { WalletTransactionView } from "./WalletTransactionViewProjector.ts";

export * from "./WalletTransactionViewProjector.ts";

// What the views module runs for this slice (processes.ts).
export const walletTransactionsViews = [WalletTransactionView];
