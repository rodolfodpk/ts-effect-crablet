import { Effect } from "effect";
import { SqlClient } from "@effect/sql";
import type { SqlError } from "@effect/sql/SqlError";
import type { StoredEvent } from "@crablet/eventstore";
import { makeTransactionalViewProjector, type ViewProjector } from "@crablet/views/ViewProjector";
import * as WalletEvents from "../domain/events/WalletEvents.ts";

// Port of com.crablet.wallet.view.projectors.WalletSummaryViewProjector - running totals per
// wallet. `current_balance` is always SET to the event's own carried balance (naturally
// idempotent, same as WalletBalanceViewProjector); the running total_* columns are incremented,
// with `last_transaction_at = GREATEST(...)` guarding only the timestamp against moving backward
// on an out-of-order redelivery - this port keeps the same accepted limitation Java's own summary
// view has (unlike WalletStatementViewProjector, there's no junction table here, so a genuine
// redelivery could double-count a total_* column; Java's own design doesn't solve this either).
// Deliberately no FK to wallet_balance_view (Java's own V103 migration fix - both are independent
// async projections off the same event stream, so summary's own projector can process
// WalletOpened before balance's does).
const upsertOnOpen = (
  sql: SqlClient.SqlClient,
  walletId: string,
  initialBalance: number
): Effect.Effect<void, SqlError, never> =>
  Effect.asVoid(
    sql.unsafe(
      `INSERT INTO wallet_summary_view (wallet_id, current_balance)
       VALUES ($1, $2)
       ON CONFLICT (wallet_id) DO UPDATE SET current_balance = EXCLUDED.current_balance`,
      [walletId, initialBalance]
    )
  );

const incrementColumn = (
  sql: SqlClient.SqlClient,
  column: "total_deposits" | "total_withdrawals" | "total_transfers_in" | "total_transfers_out",
  walletId: string,
  amount: number,
  balance: number,
  occurredAt: string
): Effect.Effect<void, SqlError, never> =>
  Effect.asVoid(
    sql.unsafe(
      `INSERT INTO wallet_summary_view (wallet_id, ${column}, current_balance, last_transaction_at)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (wallet_id) DO UPDATE SET
         ${column} = wallet_summary_view.${column} + EXCLUDED.${column},
         current_balance = EXCLUDED.current_balance,
         last_transaction_at = GREATEST(wallet_summary_view.last_transaction_at, EXCLUDED.last_transaction_at)`,
      [walletId, amount, balance, occurredAt]
    )
  );

const handleEvent = (event: StoredEvent, sql: SqlClient.SqlClient): Effect.Effect<void, SqlError, never> => {
  switch (event.type) {
    case WalletEvents.WALLET_OPENED: {
      const data = event.data as WalletEvents.WalletOpened;
      return upsertOnOpen(sql, data.walletId, data.initialBalance);
    }
    case WalletEvents.DEPOSIT_MADE: {
      const data = event.data as WalletEvents.DepositMade;
      return incrementColumn(sql, "total_deposits", data.walletId, data.amount, data.newBalance, data.depositedAt);
    }
    case WalletEvents.WITHDRAWAL_MADE: {
      const data = event.data as WalletEvents.WithdrawalMade;
      return incrementColumn(sql, "total_withdrawals", data.walletId, data.amount, data.newBalance, data.withdrawnAt);
    }
    case WalletEvents.MONEY_TRANSFERRED: {
      const data = event.data as WalletEvents.MoneyTransferred;
      return Effect.gen(function* () {
        yield* incrementColumn(sql, "total_transfers_out", data.fromWalletId, data.amount, data.fromBalance, data.transferredAt);
        yield* incrementColumn(sql, "total_transfers_in", data.toWalletId, data.amount, data.toBalance, data.transferredAt);
      });
    }
    case WalletEvents.WALLET_CLOSED: {
      const data = event.data as WalletEvents.WalletClosed;
      return Effect.asVoid(sql.unsafe("DELETE FROM wallet_summary_view WHERE wallet_id = $1", [data.walletId]));
    }
    default:
      return Effect.void;
  }
};

export const makeWalletSummaryViewProjector = (): Effect.Effect<ViewProjector<SqlError>, never, SqlClient.SqlClient> =>
  makeTransactionalViewProjector("wallet-summary-view", handleEvent);
