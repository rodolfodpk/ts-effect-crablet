// The wallet-balance slice: the balance of each wallet, a view the read endpoints (src/api) use.
import { WalletBalanceView } from "./WalletBalanceViewProjector.ts";

export * from "./WalletBalanceViewProjector.ts";

// What the views module runs for this slice (processes.ts).
export const walletBalanceViews = [WalletBalanceView];
