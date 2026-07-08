import { Effect } from "effect";
import { SqlClient } from "@effect/sql";
import type { SqlError } from "@effect/sql/SqlError";
import type { StoredEvent } from "@crablet/eventstore";
import { makeTransactionalViewProjector, type ViewProjector } from "@crablet/views/ViewProjector";
import * as WalletEvents from "../domain/events/WalletEvents.ts";

// Port of com.crablet.wallet.view.projectors.WalletTransactionViewProjector - one row per
// transaction event, `ON CONFLICT (transaction_id, event_position) DO NOTHING` for idempotency. A
// transfer produces two rows ({transferId}-from negative amount, {transferId}-to positive
// amount), one per affected wallet.
const insertRow = (
  sql: SqlClient.SqlClient,
  args: {
    readonly transactionId: string;
    readonly walletId: string;
    readonly eventType: string;
    readonly amount: number;
    readonly description: string;
    readonly occurredAt: string;
    readonly position: bigint;
  }
): Effect.Effect<void, SqlError, never> =>
  Effect.asVoid(
    sql.unsafe(
      `INSERT INTO wallet_transaction_view (transaction_id, wallet_id, event_type, amount, description, occurred_at, event_position)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (transaction_id, event_position) DO NOTHING`,
      [args.transactionId, args.walletId, args.eventType, args.amount, args.description, args.occurredAt, args.position.toString()]
    )
  );

const handleEvent = (event: StoredEvent, sql: SqlClient.SqlClient): Effect.Effect<void, SqlError, never> => {
  switch (event.type) {
    case WalletEvents.DEPOSIT_MADE: {
      const data = event.data as WalletEvents.DepositMade;
      return insertRow(sql, {
        transactionId: data.depositId,
        walletId: data.walletId,
        eventType: WalletEvents.DEPOSIT_MADE,
        amount: data.amount,
        description: data.description,
        occurredAt: data.depositedAt,
        position: event.position
      });
    }
    case WalletEvents.WITHDRAWAL_MADE: {
      const data = event.data as WalletEvents.WithdrawalMade;
      return insertRow(sql, {
        transactionId: data.withdrawalId,
        walletId: data.walletId,
        eventType: WalletEvents.WITHDRAWAL_MADE,
        amount: -data.amount,
        description: data.description,
        occurredAt: data.withdrawnAt,
        position: event.position
      });
    }
    case WalletEvents.MONEY_TRANSFERRED: {
      const data = event.data as WalletEvents.MoneyTransferred;
      return Effect.gen(function* () {
        yield* insertRow(sql, {
          transactionId: `${data.transferId}-from`,
          walletId: data.fromWalletId,
          eventType: WalletEvents.MONEY_TRANSFERRED,
          amount: -data.amount,
          description: data.description,
          occurredAt: data.transferredAt,
          position: event.position
        });
        yield* insertRow(sql, {
          transactionId: `${data.transferId}-to`,
          walletId: data.toWalletId,
          eventType: WalletEvents.MONEY_TRANSFERRED,
          amount: data.amount,
          description: data.description,
          occurredAt: data.transferredAt,
          position: event.position
        });
      });
    }
    default:
      return Effect.void;
  }
};

export const makeWalletTransactionViewProjector = (): Effect.Effect<ViewProjector<SqlError>, never, SqlClient.SqlClient> =>
  makeTransactionalViewProjector("wallet-transaction-view", handleEvent);
