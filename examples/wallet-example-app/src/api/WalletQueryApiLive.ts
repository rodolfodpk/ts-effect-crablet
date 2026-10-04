import { Effect, Layer } from "effect";
import type { HttpApi, HttpApiGroup } from "effect/http-api";
import { HttpApiBuilder } from "effect/http-api";
import { SqlClient } from "effect/sql";
import { CommandApiBadRequest } from "@crablet/commands-http/ProblemDetail";
import { makeConsistentRead } from "@crablet/views-http";
import { defaultReadConsistency, type ConsistencyParams, type ReadConsistencyConfig } from "@crablet/views-http/ReadConsistency";
import { walletBalanceViewSubscription, walletSummaryViewSubscription, walletTransactionViewSubscription } from "../views/WalletViewConfig.ts";
import { WalletNotFoundProblem } from "./WalletProblems.ts";
import { decodeTransactionCursor, encodeTransactionCursor, maxPageSize, parseLimit } from "./TransactionPaging.ts";

interface BalanceRow {
  readonly wallet_id: string;
  readonly owner: string;
  readonly balance: string;
  readonly last_updated_at: Date;
}

interface TransactionRow {
  readonly transaction_id: string;
  readonly wallet_id: string;
  readonly event_type: string;
  readonly amount: string;
  readonly description: string;
  readonly occurred_at: Date;
  // The same instant as `occurred_at`, as Postgres prints it (microseconds kept), and the row's event position: what the page cursor is made of.
  // They must NOT be aliased to the column names: an ORDER BY name resolves to an output column first, so `event_position` would sort as text.
  readonly occurred_at_text: string;
  readonly event_position_text: string;
}

interface SummaryRow {
  readonly wallet_id: string;
  readonly total_deposits: string;
  readonly total_withdrawals: string;
  readonly total_transfers_in: string;
  readonly total_transfers_out: string;
  readonly current_balance: string;
  readonly last_transaction_at: Date | null;
}

// #region read-consistency
// The wallet's reads are consistent by default (ADR-0015): strict, and a read with no marker waits for the head of the log, so a read made
// after a write sees it, with no polling and no `?waitFor`. A read that carries the write's marker (`?consistentWith=<marker>`) waits only
// for that write. If a view is not there in time the read is a 503, never a stale answer; a client cannot ask for a looser read
// (`clientMayRelax` is off).
export const walletReadConsistency: ReadConsistencyConfig = defaultReadConsistency;
const consistentRead = makeConsistentRead({ config: walletReadConsistency });
// #endregion read-consistency

interface WalletRequest {
  readonly params: { readonly walletId: string };
  readonly query: ConsistencyParams;
}

// Same `any`-cast composability boundary @crablet/commands-http/CommandApiLive.ts's
// makeCommandApiGroupLive establishes and documents - HttpApiBuilder.group's own signature can't
// statically prove an arbitrary caller-supplied `Groups` contains this literal group name.
export const makeWalletQueryApiLive = <ApiId extends string, Groups extends HttpApiGroup.Constraint>(
  api: HttpApi.HttpApi<ApiId, Groups>
): Layer.Layer<HttpApiGroup.Service<ApiId, "walletQueries">, never, SqlClient.SqlClient> => {
  const groupBuilder = HttpApiBuilder.group as any;
  return groupBuilder(api, "walletQueries", (handlers: any) =>
    Effect.succeed(
      handlers
        .handle(
          "getWallet",
          consistentRead(
            { reads: [walletBalanceViewSubscription], parse: (request: WalletRequest) => Effect.succeed(request.params) },
            (params: { readonly walletId: string }) =>
              Effect.gen(function* () {
                const sql = yield* SqlClient.SqlClient;
                const rows = yield* Effect.orDie(sql.unsafe<BalanceRow>("SELECT * FROM wallet_balance_view WHERE wallet_id = $1", [params.walletId]));
                const row = rows[0];
                if (!row) return yield* Effect.fail(WalletNotFoundProblem.of(params.walletId));
                return {
                  walletId: row.wallet_id,
                  owner: row.owner,
                  balance: Number(row.balance),
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
              reads: [walletTransactionViewSubscription],
              parse: (request: WalletRequest & { readonly query: ConsistencyParams & { readonly limit?: string; readonly after?: string } }) => {
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
                const columns =
                  "transaction_id, wallet_id, event_type, amount, description, occurred_at, occurred_at::text AS occurred_at_text, event_position::text AS event_position_text";
                const order = "ORDER BY occurred_at DESC, event_position DESC, transaction_id DESC";
                const rows = yield* Effect.orDie(
                  cursor === null
                    ? sql.unsafe<TransactionRow>(`SELECT ${columns} FROM wallet_transaction_view WHERE wallet_id = $1 ${order} LIMIT $2`, [walletId, limit + 1])
                    : sql.unsafe<TransactionRow>(
                        `SELECT ${columns} FROM wallet_transaction_view
                         WHERE wallet_id = $1 AND (occurred_at, event_position, transaction_id) < ($2::timestamptz, $3::bigint, $4::text)
                         ${order} LIMIT $5`,
                        [walletId, cursor.occurredAt, cursor.eventPosition, cursor.transactionId, limit + 1]
                      )
                );
                const page = rows.slice(0, limit);
                const last = page[page.length - 1];
                return {
                  transactions: page.map((row) => ({
                    transactionId: row.transaction_id,
                    walletId: row.wallet_id,
                    eventType: row.event_type,
                    amount: Number(row.amount),
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
            { reads: [walletSummaryViewSubscription], parse: (request: WalletRequest) => Effect.succeed(request.params) },
            (params: { readonly walletId: string }) =>
              Effect.gen(function* () {
                const sql = yield* SqlClient.SqlClient;
                const rows = yield* Effect.orDie(sql.unsafe<SummaryRow>("SELECT * FROM wallet_summary_view WHERE wallet_id = $1", [params.walletId]));
                const row = rows[0];
                if (!row) return yield* Effect.fail(WalletNotFoundProblem.of(params.walletId));
                return {
                  walletId: row.wallet_id,
                  totalDeposits: Number(row.total_deposits),
                  totalWithdrawals: Number(row.total_withdrawals),
                  totalTransfersIn: Number(row.total_transfers_in),
                  totalTransfersOut: Number(row.total_transfers_out),
                  currentBalance: Number(row.current_balance),
                  lastTransactionAt: row.last_transaction_at?.toISOString() ?? null
                };
              })
          )
        )
    )
  );
};
