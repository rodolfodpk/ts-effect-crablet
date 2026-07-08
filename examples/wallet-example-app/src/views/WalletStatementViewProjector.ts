import { Effect } from "effect";
import { SqlClient } from "@effect/sql";
import type { SqlError } from "@effect/sql/SqlError";
import type { StoredEvent } from "@crablet/eventstore";
import { makeTransactionalViewProjector, type ViewProjector } from "@crablet/views/ViewProjector";
import * as WalletTags from "../domain/WalletTags.ts";
import * as WalletEvents from "../domain/events/WalletEvents.ts";

// Port of com.crablet.wallet.view.projectors.WalletStatementViewProjector - the most edge-case-
// heavy projector in the app (Java's own fidelity bar: a 713-line, ~20-test unit suite). Maintains
// wallet_statement_view (one row per (wallet, period) statement) + the statement_transactions
// junction table.
//
// Idempotency strategy, deliberately stronger than `ON CONFLICT DO NOTHING` on the statement row
// alone: for every event that *updates* running totals (not the initial open), first INSERT INTO
// statement_transactions (statement_id, event_position) - only if THAT insert actually happens
// (not a redelivery of an already-folded-in event) do we apply the totals update. This is what
// makes re-processing the same batch (a crash between handling and progress-commit, or a
// redelivered StoredEvent) safe - a delivery that redoes the junction insert is a no-op, not a
// double-counted total.
const tagValue = (event: StoredEvent, key: string): string | undefined => event.tags.find((t) => t.key === key)?.value;

const recordProcessedEvent = (
  sql: SqlClient.SqlClient,
  statementId: string,
  position: bigint
): Effect.Effect<boolean, SqlError, never> =>
  sql
    .unsafe<{ ok: number }>(
      "INSERT INTO statement_transactions (statement_id, event_position) VALUES ($1, $2) ON CONFLICT DO NOTHING RETURNING 1 AS ok",
      [statementId, position.toString()]
    )
    .pipe(Effect.map((rows) => rows.length > 0));

const handleStatementOpened = (event: StoredEvent, sql: SqlClient.SqlClient): Effect.Effect<void, SqlError, never> => {
  const data = event.data as WalletEvents.WalletStatementOpened;
  return Effect.asVoid(
    sql.unsafe(
      `INSERT INTO wallet_statement_view (statement_id, wallet_id, year, month, day, hour, opening_balance, opened_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (statement_id) DO NOTHING`,
      [data.statementId, data.walletId, data.year, data.month ?? null, data.day ?? null, data.hour ?? null, data.openingBalance, data.openedAt]
    )
  );
};

const handleStatementClosed = (event: StoredEvent, sql: SqlClient.SqlClient): Effect.Effect<void, SqlError, never> =>
  Effect.gen(function* () {
    const data = event.data as WalletEvents.WalletStatementClosed;
    const isNew = yield* recordProcessedEvent(sql, data.statementId, event.position);
    if (!isNew) return;
    yield* sql.unsafe("UPDATE wallet_statement_view SET closing_balance = $1, closed_at = $2 WHERE statement_id = $3", [
      data.closingBalance,
      data.closedAt,
      data.statementId
    ]);
  });

const handleDepositMade = (event: StoredEvent, sql: SqlClient.SqlClient): Effect.Effect<void, SqlError, never> =>
  Effect.gen(function* () {
    const statementId = tagValue(event, WalletTags.STATEMENT_ID);
    if (!statementId) return;
    const isNew = yield* recordProcessedEvent(sql, statementId, event.position);
    if (!isNew) return;
    const data = event.data as WalletEvents.DepositMade;
    yield* sql.unsafe(
      "UPDATE wallet_statement_view SET total_deposits = total_deposits + $1, transaction_count = transaction_count + 1 WHERE statement_id = $2",
      [data.amount, statementId]
    );
  });

const handleWithdrawalMade = (event: StoredEvent, sql: SqlClient.SqlClient): Effect.Effect<void, SqlError, never> =>
  Effect.gen(function* () {
    const statementId = tagValue(event, WalletTags.STATEMENT_ID);
    if (!statementId) return;
    const isNew = yield* recordProcessedEvent(sql, statementId, event.position);
    if (!isNew) return;
    const data = event.data as WalletEvents.WithdrawalMade;
    yield* sql.unsafe(
      "UPDATE wallet_statement_view SET total_withdrawals = total_withdrawals + $1, transaction_count = transaction_count + 1 WHERE statement_id = $2",
      [data.amount, statementId]
    );
  });

// A transfer touches two wallets, each with its own statement_id (see WalletTags.ts's primer) -
// each side is recorded/updated independently, so one side succeeding doesn't depend on the other.
const handleMoneyTransferred = (event: StoredEvent, sql: SqlClient.SqlClient): Effect.Effect<void, SqlError, never> =>
  Effect.gen(function* () {
    const data = event.data as WalletEvents.MoneyTransferred;
    const fromStatementId = tagValue(event, WalletTags.FROM_STATEMENT_ID);
    const toStatementId = tagValue(event, WalletTags.TO_STATEMENT_ID);

    if (fromStatementId) {
      const isNew = yield* recordProcessedEvent(sql, fromStatementId, event.position);
      if (isNew) {
        yield* sql.unsafe(
          "UPDATE wallet_statement_view SET total_transfers_out = total_transfers_out + $1, transaction_count = transaction_count + 1 WHERE statement_id = $2",
          [data.amount, fromStatementId]
        );
      }
    }
    if (toStatementId) {
      const isNew = yield* recordProcessedEvent(sql, toStatementId, event.position);
      if (isNew) {
        yield* sql.unsafe(
          "UPDATE wallet_statement_view SET total_transfers_in = total_transfers_in + $1, transaction_count = transaction_count + 1 WHERE statement_id = $2",
          [data.amount, toStatementId]
        );
      }
    }
  });

const handleEvent = (event: StoredEvent, sql: SqlClient.SqlClient): Effect.Effect<void, SqlError, never> => {
  switch (event.type) {
    case WalletEvents.WALLET_STATEMENT_OPENED:
      return handleStatementOpened(event, sql);
    case WalletEvents.WALLET_STATEMENT_CLOSED:
      return handleStatementClosed(event, sql);
    case WalletEvents.DEPOSIT_MADE:
      return handleDepositMade(event, sql);
    case WalletEvents.WITHDRAWAL_MADE:
      return handleWithdrawalMade(event, sql);
    case WalletEvents.MONEY_TRANSFERRED:
      return handleMoneyTransferred(event, sql);
    default:
      return Effect.void;
  }
};

export const makeWalletStatementViewProjector = (): Effect.Effect<
  ViewProjector<SqlError>,
  never,
  SqlClient.SqlClient
> => makeTransactionalViewProjector("wallet-statement-view", handleEvent);
