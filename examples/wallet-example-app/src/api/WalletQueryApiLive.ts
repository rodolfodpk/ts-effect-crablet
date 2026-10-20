import { Effect, Layer, Option, Schema } from "effect";
import { HttpApiBuilder } from "effect/http-api";
import { SqlClient, SqlSchema } from "effect/sql";
import { CommandApiBadRequest } from "@crablet/commands-http/ProblemDetail";
import { makeConsistentRead } from "@crablet/views-http";
import { defaultReadConsistency, type ReadConsistencyConfig } from "@crablet/views-http/ReadConsistency";
import type { WalletApi } from "../WalletApp.ts";
import { WalletBalanceView } from "../views/WalletBalanceViewProjector.ts";
import { WalletSummaryView } from "../views/WalletSummaryViewProjector.ts";
import { WalletTransactionView } from "../views/WalletTransactionViewProjector.ts";
import { WalletNotFoundProblem } from "./WalletProblems.ts";
import { decodeWalletCursor, encodeWalletCursor } from "./WalletListPaging.ts";
import { decodeTransactionCursor, encodeTransactionCursor, maxPageSize, parseLimit } from "./TransactionPaging.ts";

// A row of wallet_balance_view as the database sends it, checked on every read: a column that was renamed or changed type fails here, naming the field, and not later in a conversion.
// `balance` is a numeric, which the driver sends as text: it becomes a number here.
const BalanceRow = Schema.Struct({
  wallet_id: Schema.String,
  owner: Schema.String,
  balance: Schema.FiniteFromString,
  last_updated_at: Schema.Date
});

// One page of the list, by keyset on wallet_id; `after` null is the first page.
const listBalances = (sql: SqlClient.SqlClient) =>
  SqlSchema.findAll({
    Request: Schema.Struct({ after: Schema.NullOr(Schema.String), limit: Schema.Number }),
    Result: BalanceRow,
    execute: ({ after, limit }) =>
      after === null
        ? sql.unsafe("SELECT * FROM wallet_balance_view ORDER BY wallet_id LIMIT $1", [limit])
        : sql.unsafe("SELECT * FROM wallet_balance_view WHERE wallet_id > $1 ORDER BY wallet_id LIMIT $2", [after, limit])
  });

const findBalance = (sql: SqlClient.SqlClient) =>
  SqlSchema.findOneOption({
    Request: Schema.Struct({ walletId: Schema.String }),
    Result: BalanceRow,
    execute: ({ walletId }) => sql.unsafe("SELECT * FROM wallet_balance_view WHERE wallet_id = $1", [walletId])
  });

// A row of wallet_transaction_view as the database sends it. The numeric `amount` arrives as text and becomes a number here.
// `occurred_at_text` is the same instant as `occurred_at`, as Postgres prints it (microseconds kept), and `event_position_text` the row's event position: what the page cursor is made of.
// They must NOT be aliased to the column names: an ORDER BY name resolves to an output column first, so `event_position` would sort as text.
const TransactionRow = Schema.Struct({
  transaction_id: Schema.String,
  wallet_id: Schema.String,
  event_type: Schema.String,
  amount: Schema.FiniteFromString,
  description: Schema.String,
  occurred_at: Schema.Date,
  occurred_at_text: Schema.String,
  event_position_text: Schema.String
});

const transactionColumns =
  "transaction_id, wallet_id, event_type, amount, description, occurred_at, occurred_at::text AS occurred_at_text, event_position::text AS event_position_text";
const transactionOrder = "ORDER BY occurred_at DESC, event_position DESC, transaction_id DESC";

// One page of a wallet's transactions, newest first, by keyset; `cursor` null is the first page.
const listTransactions = (sql: SqlClient.SqlClient) =>
  SqlSchema.findAll({
    Request: Schema.Struct({
      walletId: Schema.String,
      limit: Schema.Number,
      cursor: Schema.NullOr(Schema.Struct({ occurredAt: Schema.String, eventPosition: Schema.String, transactionId: Schema.String }))
    }),
    Result: TransactionRow,
    execute: ({ walletId, limit, cursor }) =>
      cursor === null
        ? sql.unsafe(`SELECT ${transactionColumns} FROM wallet_transaction_view WHERE wallet_id = $1 ${transactionOrder} LIMIT $2`, [walletId, limit])
        : sql.unsafe(
            `SELECT ${transactionColumns} FROM wallet_transaction_view
             WHERE wallet_id = $1 AND (occurred_at, event_position, transaction_id) < ($2::timestamptz, $3::bigint, $4::text)
             ${transactionOrder} LIMIT $5`,
            [walletId, cursor.occurredAt, cursor.eventPosition, cursor.transactionId, limit]
          )
  });

// A row of wallet_summary_view as the database sends it; the numerics arrive as text.
const SummaryRow = Schema.Struct({
  wallet_id: Schema.String,
  total_deposits: Schema.FiniteFromString,
  total_withdrawals: Schema.FiniteFromString,
  total_transfers_in: Schema.FiniteFromString,
  total_transfers_out: Schema.FiniteFromString,
  current_balance: Schema.FiniteFromString,
  last_transaction_at: Schema.NullOr(Schema.Date)
});

const findSummary = (sql: SqlClient.SqlClient) =>
  SqlSchema.findOneOption({
    Request: Schema.Struct({ walletId: Schema.String }),
    Result: SummaryRow,
    execute: ({ walletId }) => sql.unsafe("SELECT * FROM wallet_summary_view WHERE wallet_id = $1", [walletId])
  });

// #region read-consistency
// The wallet's reads are consistent by default (ADR-0015): strict, and a read with no marker waits for the head of the log, so a read made
// after a write sees it, with no polling. A read that carries the write's marker (`?consistentWith=<marker>`) waits only
// for that write. If a view is not there in time the read is a 503, never a stale answer; a client cannot ask for a looser read
// (`clientMayRelax` is off).
export const walletReadConsistency: ReadConsistencyConfig = defaultReadConsistency;
const consistentRead = makeConsistentRead({ config: walletReadConsistency });
// #endregion read-consistency

// The read group, implemented against the wallet API itself: each handler's request and response are checked against its endpoint.
export const makeWalletQueryApiLive = (api: WalletApi) =>
  HttpApiBuilder.group(api, "walletQueries", (handlers) =>
    Effect.succeed(
      handlers
        // The list of wallets, from the balance view, by keyset on wallet_id (no OFFSET, so a wallet that appears between two requests cannot shift the pages). Like every read it waits for its view.
        .handle(
          "listWallets",
          consistentRead(
            {
              reads: [WalletBalanceView],
              parse: (request) => {
                const limit = parseLimit(request.query.limit);
                if (limit === null) return Effect.fail(CommandApiBadRequest.of(`limit must be a whole number from 1 to ${maxPageSize}`));
                const after = request.query.after === undefined ? null : decodeWalletCursor(request.query.after);
                if (request.query.after !== undefined && after === null) return Effect.fail(CommandApiBadRequest.of("after must be the next cursor of a previous page"));
                return Effect.succeed({ limit, after });
              }
            },
            ({ limit, after }) =>
              Effect.gen(function* () {
                const sql = yield* SqlClient.SqlClient;
                const rows = yield* Effect.orDie(listBalances(sql)({ after, limit: limit + 1 }));
                const page = rows.slice(0, limit);
                const last = page[page.length - 1];
                return {
                  wallets: page.map((row) => ({ walletId: row.wallet_id, owner: row.owner, balance: row.balance, lastUpdatedAt: row.last_updated_at.toISOString() })),
                  next: rows.length > limit && last !== undefined ? encodeWalletCursor(last.wallet_id) : null
                };
              })
          )
        )
        .handle(
          "getWallet",
          consistentRead(
            { reads: [WalletBalanceView], parse: (request) => Effect.succeed(request.params) },
            (params) =>
              Effect.gen(function* () {
                const sql = yield* SqlClient.SqlClient;
                const found = yield* Effect.orDie(findBalance(sql)({ walletId: params.walletId }));
                if (Option.isNone(found)) return yield* Effect.fail(WalletNotFoundProblem.of(params.walletId));
                const row = found.value;
                return {
                  walletId: row.wallet_id,
                  owner: row.owner,
                  balance: row.balance,
                  lastUpdatedAt: row.last_updated_at.toISOString()
                };
              })
          )
        )
        // Keyset pagination in the view's own order, newest first: (occurred_at, event_position, transaction_id) descending, which is
        // idx_wallet_transaction_view_wallet_page. No OFFSET: a page costs the same however deep it is, and a transaction that arrives
        // between two requests cannot shift the pages (OFFSET would repeat or skip a row). One extra row is read to know whether there is a next page.
        // `parse` validates limit and cursor BEFORE the read waits for the view, so a bad request is a 400 at once.
        .handle(
          "getWalletTransactions",
          consistentRead(
            {
              reads: [WalletTransactionView],
              parse: (request) => {
                const limit = parseLimit(request.query.limit);
                if (limit === null) return Effect.fail(CommandApiBadRequest.of(`limit must be a whole number from 1 to ${maxPageSize}`));
                const cursor = request.query.after === undefined ? null : decodeTransactionCursor(request.query.after);
                if (request.query.after !== undefined && cursor === null) {
                  return Effect.fail(CommandApiBadRequest.of("after must be the next cursor of a previous page"));
                }
                return Effect.succeed({ walletId: request.params.walletId, limit, cursor });
              }
            },
            ({ walletId, limit, cursor }) =>
              Effect.gen(function* () {
                const sql = yield* SqlClient.SqlClient;
                const rows = yield* Effect.orDie(listTransactions(sql)({ walletId, limit: limit + 1, cursor }));
                const page = rows.slice(0, limit);
                const last = page[page.length - 1];
                return {
                  transactions: page.map((row) => ({
                    transactionId: row.transaction_id,
                    walletId: row.wallet_id,
                    eventType: row.event_type,
                    amount: row.amount,
                    description: row.description,
                    occurredAt: row.occurred_at.toISOString()
                  })),
                  next:
                    rows.length > limit && last !== undefined
                      ? encodeTransactionCursor({ occurredAt: last.occurred_at_text, eventPosition: last.event_position_text, transactionId: last.transaction_id })
                      : null
                };
              })
          )
        )
        .handle(
          "getWalletSummary",
          consistentRead(
            { reads: [WalletSummaryView], parse: (request) => Effect.succeed(request.params) },
            (params) =>
              Effect.gen(function* () {
                const sql = yield* SqlClient.SqlClient;
                const found = yield* Effect.orDie(findSummary(sql)({ walletId: params.walletId }));
                if (Option.isNone(found)) return yield* Effect.fail(WalletNotFoundProblem.of(params.walletId));
                const row = found.value;
                return {
                  walletId: row.wallet_id,
                  totalDeposits: row.total_deposits,
                  totalWithdrawals: row.total_withdrawals,
                  totalTransfersIn: row.total_transfers_in,
                  totalTransfersOut: row.total_transfers_out,
                  currentBalance: row.current_balance,
                  lastTransactionAt: row.last_transaction_at?.toISOString() ?? null
                };
              })
          )
        )
    )
  );
