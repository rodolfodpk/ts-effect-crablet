import { Effect, Layer } from "effect";
import type { HttpApi, HttpApiGroup } from "effect/http-api";
import { HttpApiBuilder } from "effect/http-api";
import { SqlClient } from "effect/sql";
import { WalletNotFoundProblem } from "./WalletProblems.ts";

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
      .handle("getWallet", ({ params }: { params: { walletId: string } }) =>
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          const rows = yield* sql.unsafe<BalanceRow>("SELECT * FROM wallet_balance_view WHERE wallet_id = $1", [
            params.walletId
          ]);
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
      .handle(
        "getWalletTransactions",
        ({ params, query }: { params: { walletId: string }; query: { page?: number; size?: number } }) =>
          Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            const size = query.size ?? 20;
            const page = query.page ?? 0;
            const rows = yield* sql.unsafe<TransactionRow>(
              "SELECT * FROM wallet_transaction_view WHERE wallet_id = $1 ORDER BY occurred_at DESC LIMIT $2 OFFSET $3",
              [params.walletId, size, page * size]
            );
            return {
              transactions: rows.map((row) => ({
                transactionId: row.transaction_id,
                walletId: row.wallet_id,
                eventType: row.event_type,
                amount: Number(row.amount),
                description: row.description,
                occurredAt: row.occurred_at.toISOString()
              }))
            };
          })
      )
      .handle("getWalletSummary", ({ params }: { params: { walletId: string } }) =>
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          const rows = yield* sql.unsafe<SummaryRow>("SELECT * FROM wallet_summary_view WHERE wallet_id = $1", [
            params.walletId
          ]);
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
  );
};
