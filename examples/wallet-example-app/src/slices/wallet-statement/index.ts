// The wallet-statement slice: the monthly statements, a view the read endpoints (src/api) use.
import { WalletStatementView } from "./WalletStatementViewProjector.ts";

export * from "./WalletStatementViewProjector.ts";

// What the views module runs for this slice (processes.ts).
export const walletStatementViews = [WalletStatementView];
