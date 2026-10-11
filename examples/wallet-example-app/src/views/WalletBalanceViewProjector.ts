import { Effect } from "effect";
import type { SqlClient } from "effect/sql";
import type { SqlError } from "effect/sql/SqlError";
import type { EventDecodingError } from "@crablet/eventstore/EventDecoding";
import { defineView } from "@crablet/views/ProjectedView";
import type { ViewProjector } from "@crablet/views/ViewProjector";
import { decimal, text, timestamptz, viewTable } from "@crablet/views/ViewTable";
import * as Wallet from "../domain/WalletModel.ts";

export const walletBalanceTable = viewTable("wallet_balance_view", {
  key: { wallet_id: text() },
  columns: { owner: text(), balance: decimal(), last_updated_at: timestamptz() }
});

// The balance is the SUM of the changes, not a copy of the `newBalance` in the event: every deposit, withdrawal and transfer adds or subtracts its amount (`add`).
// Deposits are concurrent: the number a deposit records is the balance of the moment it was decided, and a credit that committed in between makes it stale. Copying it overwrote the right balance
// with an old one (the kind lab's consistency check found 22 to 28 wallets of several hundred wrong that way).
//
// An increment is not idempotent by itself, but the view's batch and its cursor commit in one transaction (ViewsModule: `atomically`, ADR-0023), so a batch handled twice is applied once.
//
// WalletClosed deletes the row - the subscription (WalletViewConfig.ts) deliberately includes it for this view.
export const WalletBalanceView = defineView("wallet-balance-view", { tables: [walletBalanceTable] })
  .on(Wallet.WalletOpened, (d) =>
    walletBalanceTable.insert({ wallet_id: d.walletId, owner: d.owner, balance: d.initialBalance, last_updated_at: d.openedAt }, { onConflict: "replace" })
  )
  .on(Wallet.DepositMade, (d) => walletBalanceTable.update({ wallet_id: d.walletId }, { add: { balance: d.amount }, set: { last_updated_at: d.depositedAt } }))
  .on(Wallet.WithdrawalMade, (d) => walletBalanceTable.update({ wallet_id: d.walletId }, { add: { balance: -d.amount }, set: { last_updated_at: d.withdrawnAt } }))
  .on(Wallet.MoneyTransferred, (d) => [
    walletBalanceTable.update({ wallet_id: d.fromWalletId }, { add: { balance: -d.amount }, set: { last_updated_at: d.transferredAt } }),
    walletBalanceTable.update({ wallet_id: d.toWalletId }, { add: { balance: d.amount }, set: { last_updated_at: d.transferredAt } })
  ])
  .on(Wallet.WalletClosed, (d) => walletBalanceTable.remove({ wallet_id: d.walletId }));

export const makeWalletBalanceViewProjector = (): Effect.Effect<ViewProjector<SqlError | EventDecodingError>, never, SqlClient.SqlClient> => WalletBalanceView.projector;
