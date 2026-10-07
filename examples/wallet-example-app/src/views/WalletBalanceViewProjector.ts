import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import type { SqlError } from "effect/sql/SqlError";
import type { StoredEvent } from "@crablet/eventstore";
import { makeTransactionalViewProjector, type ViewProjector } from "@crablet/views/ViewProjector";
import type { EventDecodingError } from "@crablet/eventstore/EventDecoding";
import * as Wallet from "../domain/WalletModel.ts";
import * as WalletEvents from "../domain/events/WalletEvents.ts";

// Deposit/Withdrawal/
// Transfer always SET the balance to the event's own carried `newBalance`/`fromBalance`/
// `toBalance` (never increment) - naturally idempotent under redelivery, no junction table needed
// (unlike WalletStatementViewProjector, which increments running totals and does need one).
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
        sql.unsafe("UPDATE wallet_balance_view SET balance = $1, last_updated_at = $2 WHERE wallet_id = $3", [
          data.newBalance,
          data.depositedAt,
          data.walletId
        ])
      );
    }
    case WalletEvents.WITHDRAWAL_MADE: {
      const data = yield* Wallet.WithdrawalMade.decodeStored(event);
      return yield* Effect.asVoid(
        sql.unsafe("UPDATE wallet_balance_view SET balance = $1, last_updated_at = $2 WHERE wallet_id = $3", [
          data.newBalance,
          data.withdrawnAt,
          data.walletId
        ])
      );
    }
    case WalletEvents.MONEY_TRANSFERRED: {
      const data = yield* Wallet.MoneyTransferred.decodeStored(event);
      return yield* Effect.gen(function* () {
        yield* sql.unsafe("UPDATE wallet_balance_view SET balance = $1, last_updated_at = $2 WHERE wallet_id = $3", [
          data.fromBalance,
          data.transferredAt,
          data.fromWalletId
        ]);
        yield* sql.unsafe("UPDATE wallet_balance_view SET balance = $1, last_updated_at = $2 WHERE wallet_id = $3", [
          data.toBalance,
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
