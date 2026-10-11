import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import type { SqlError } from "effect/sql/SqlError";
import type { StoredEvent } from "@crablet/eventstore";
import { makeTransactionalViewProjector, type ViewProjector } from "@crablet/views/ViewProjector";
import type { EventDecodingError } from "@crablet/eventstore/EventDecoding";
import * as Wallet from "../domain/WalletModel.ts";
import * as WalletEvents from "../domain/events/WalletEvents.ts";

// The balance is the SUM of the changes, not a copy of the `newBalance` in the event: every deposit, withdrawal and transfer adds or subtracts its amount (`balance = balance + amount`).
// Deposits are concurrent: the number a deposit records is the balance of the moment it was decided, and a credit that committed in between makes it stale. Copying it overwrote the right balance
// with an old one (the kind lab's consistency check found 22 to 28 wallets of several hundred wrong that way).
//
// An increment is not idempotent by itself, but the view's batch and its cursor commit in one transaction (ViewsModule: `atomically`, ADR-0023), so a batch handled twice is applied once.
// (WalletStatementViewProjector keeps a junction table as well, for its running totals.)
//
// WalletClosed deletes the row - the ViewSubscription (WalletViewConfig.ts) deliberately subscribes
// to WalletClosed for this view.
const handleEvent = (event: StoredEvent, sql: SqlClient.SqlClient): Effect.Effect<void, SqlError | EventDecodingError, never> =>
  Effect.gen(function* () {
  switch (event.type) {
    case WalletEvents.WALLET_OPENED: {
      const data = yield* Wallet.WalletOpened.decodeStored(event);
      return yield* Effect.asVoid(
        sql.unsafe(
          `INSERT INTO wallet_balance_view (wallet_id, owner, balance, last_updated_at)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (wallet_id) DO UPDATE SET owner = EXCLUDED.owner, balance = EXCLUDED.balance, last_updated_at = EXCLUDED.last_updated_at`,
          [data.walletId, data.owner, data.initialBalance, data.openedAt]
        )
      );
    }
    case WalletEvents.DEPOSIT_MADE: {
      const data = yield* Wallet.DepositMade.decodeStored(event);
      return yield* Effect.asVoid(
        sql.unsafe("UPDATE wallet_balance_view SET balance = balance + $1, last_updated_at = $2 WHERE wallet_id = $3", [
          data.amount,
          data.depositedAt,
          data.walletId
        ])
      );
    }
    case WalletEvents.WITHDRAWAL_MADE: {
      const data = yield* Wallet.WithdrawalMade.decodeStored(event);
      return yield* Effect.asVoid(
        sql.unsafe("UPDATE wallet_balance_view SET balance = balance - $1, last_updated_at = $2 WHERE wallet_id = $3", [
          data.amount,
          data.withdrawnAt,
          data.walletId
        ])
      );
    }
    case WalletEvents.MONEY_TRANSFERRED: {
      const data = yield* Wallet.MoneyTransferred.decodeStored(event);
      return yield* Effect.gen(function* () {
        yield* sql.unsafe("UPDATE wallet_balance_view SET balance = balance - $1, last_updated_at = $2 WHERE wallet_id = $3", [
          data.amount,
          data.transferredAt,
          data.fromWalletId
        ]);
        yield* sql.unsafe("UPDATE wallet_balance_view SET balance = balance + $1, last_updated_at = $2 WHERE wallet_id = $3", [
          data.amount,
          data.transferredAt,
          data.toWalletId
        ]);
      });
    }
    case WalletEvents.WALLET_CLOSED: {
      const data = yield* Wallet.WalletClosed.decodeStored(event);
      return yield* Effect.asVoid(sql.unsafe("DELETE FROM wallet_balance_view WHERE wallet_id = $1", [data.walletId]));
    }
    default:
      return;
  }
  });

export const makeWalletBalanceViewProjector = (): Effect.Effect<ViewProjector<SqlError | EventDecodingError>, never, SqlClient.SqlClient> =>
  makeTransactionalViewProjector("wallet-balance-view", handleEvent);
