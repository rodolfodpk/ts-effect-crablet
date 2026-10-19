import { defineView } from "@crablet/views/ProjectedView";
import { decimal, text, timestamptz, viewTable } from "@crablet/views/ViewTable";
import * as WalletTags from "../domain/WalletTags.ts";
import * as Wallet from "../domain/WalletModel.ts";

export const walletSummaryTable = viewTable("wallet_summary_view", {
  key: { wallet_id: text() },
  columns: {
    total_deposits: decimal().default(0),
    total_withdrawals: decimal().default(0),
    total_transfers_in: decimal().default(0),
    total_transfers_out: decimal().default(0),
    current_balance: decimal().default(0),
    last_transaction_at: timestamptz().nullable()
  }
});

// Running totals per wallet. Every column is ADDED to (`upsert` with `add`): the totals by the amount, `current_balance` by the signed change (deposit +, withdrawal -, transfer out - and in +).
// NOT the `newBalance` recorded in the event: that is the balance of the moment the command was decided, and a credit that committed in between makes it stale (deposits are concurrent), so
// copying it loses updates. Only the opening event sets `current_balance` (`replace`: the first thing a wallet's row says).
// `last_transaction_at` only moves forward (`max`, `GREATEST` in SQL), so an out-of-order delivery cannot move it back.
// A repeated batch is applied once because the view's batch and its cursor commit together (ADR-0023); there is no junction table.
// Deliberately no FK to wallet_balance_view (both are independent async projections off the same event stream, so summary's own projector can process
// WalletOpened before balance's does).
export const WalletSummaryView = defineView("wallet-summary-view", { tables: [walletSummaryTable], anyOfTags: WalletTags.ANY_WALLET })
  .on(Wallet.WalletOpened, (d) => walletSummaryTable.insert({ wallet_id: d.walletId, current_balance: d.initialBalance }, { onConflict: "replace" }))
  .on(Wallet.DepositMade, (d) =>
    walletSummaryTable.upsert({ wallet_id: d.walletId }, { add: { total_deposits: d.amount, current_balance: d.amount }, max: { last_transaction_at: d.depositedAt } })
  )
  .on(Wallet.WithdrawalMade, (d) =>
    walletSummaryTable.upsert({ wallet_id: d.walletId }, { add: { total_withdrawals: d.amount, current_balance: -d.amount }, max: { last_transaction_at: d.withdrawnAt } })
  )
  .on(Wallet.MoneyTransferred, (d) => [
    walletSummaryTable.upsert({ wallet_id: d.fromWalletId }, { add: { total_transfers_out: d.amount, current_balance: -d.amount }, max: { last_transaction_at: d.transferredAt } }),
    walletSummaryTable.upsert({ wallet_id: d.toWalletId }, { add: { total_transfers_in: d.amount, current_balance: d.amount }, max: { last_transaction_at: d.transferredAt } })
  ])
  .on(Wallet.WalletClosed, (d) => walletSummaryTable.remove({ wallet_id: d.walletId }));

