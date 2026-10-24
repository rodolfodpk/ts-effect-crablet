import type { DateTime } from "effect";
import { defineView } from "@crablet/views/ProjectedView";
import { bigint, decimal, text, timestamptz, viewTable } from "@crablet/views/ViewTable";
import * as WalletTags from "../domain/WalletTags.ts";
import * as Wallet from "../domain/WalletModel.ts";
import * as WalletEvents from "../domain/events/WalletEvents.ts";

export const walletTransactionTable = viewTable("wallet_transaction_view", {
  key: { transaction_id: text(), event_position: bigint() },
  columns: { wallet_id: text(), event_type: text(), amount: decimal(), description: text(), occurred_at: timestamptz() }
});

// One row per transaction event, `onConflict: "ignore"` on (transaction_id, event_position). A transfer produces two rows ({transferId}-from negative amount, {transferId}-to positive
// amount), one per affected wallet.
const row = (
  position: bigint,
  transactionId: string,
  walletId: string,
  eventType: string,
  amount: number,
  description: string,
  occurredAt: DateTime.Utc
) =>
  walletTransactionTable.insert(
    { transaction_id: transactionId, event_position: position, wallet_id: walletId, event_type: eventType, amount, description, occurred_at: occurredAt },
    { onConflict: "ignore" }
  );

export const WalletTransactionView = defineView("wallet-transaction-view", { tables: [walletTransactionTable], anyOfTags: WalletTags.ANY_WALLET })
  .on(Wallet.DepositMade, (d, ctx) => row(ctx.position, d.depositId, d.walletId, WalletEvents.DEPOSIT_MADE, d.amount, d.description, d.depositedAt))
  .on(Wallet.WithdrawalMade, (d, ctx) => row(ctx.position, d.withdrawalId, d.walletId, WalletEvents.WITHDRAWAL_MADE, -d.amount, d.description, d.withdrawnAt))
  .on(Wallet.MoneyTransferred, (d, ctx) => [
    row(ctx.position, `${d.transferId}-from`, d.fromWalletId, WalletEvents.MONEY_TRANSFERRED, -d.amount, d.description, d.transferredAt),
    row(ctx.position, `${d.transferId}-to`, d.toWalletId, WalletEvents.MONEY_TRANSFERRED, d.amount, d.description, d.transferredAt)
  ]);

