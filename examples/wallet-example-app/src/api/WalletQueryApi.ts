import * as Schema from "effect/Schema";
import { HttpApiEndpoint, HttpApiGroup } from "effect/http-api";
import { WalletNotFoundProblem } from "./WalletProblems.ts";

// Hand-written reads (plain SqlClient
// queries against the view tables, no event-store involvement), composed alongside
// commands-http's generic write group under one shared HttpApi (see WalletApp.ts).
export const WalletResponse = Schema.Struct({
  walletId: Schema.String,
  owner: Schema.String,
  balance: Schema.Finite,
  lastUpdatedAt: Schema.String
});

export const TransactionResponse = Schema.Struct({
  transactionId: Schema.String,
  walletId: Schema.String,
  eventType: Schema.String,
  amount: Schema.Finite,
  description: Schema.String,
  occurredAt: Schema.String
});

export const TransactionsResponse = Schema.Struct({
  transactions: Schema.Array(TransactionResponse)
});

export const WalletSummaryResponse = Schema.Struct({
  walletId: Schema.String,
  totalDeposits: Schema.Finite,
  totalWithdrawals: Schema.Finite,
  totalTransfersIn: Schema.Finite,
  totalTransfersOut: Schema.Finite,
  currentBalance: Schema.Finite,
  lastTransactionAt: Schema.NullOr(Schema.String)
});

// Query-string params for the transactions list (both optional, parsed from strings).
export const TransactionsPageParams = {
  page: Schema.optional(Schema.NumberFromString),
  size: Schema.optional(Schema.NumberFromString)
};

const walletIdParam = { walletId: Schema.String };

export const walletQueryGroup = HttpApiGroup.make("walletQueries")
  .add(
    HttpApiEndpoint.get("getWallet", "/api/wallets/:walletId", {
      params: walletIdParam,
      success: WalletResponse,
      error: WalletNotFoundProblem
    })
  )
  .add(
    HttpApiEndpoint.get("getWalletTransactions", "/api/wallets/:walletId/transactions", {
      params: walletIdParam,
      query: TransactionsPageParams,
      success: TransactionsResponse,
      error: WalletNotFoundProblem
    })
  )
  .add(
    HttpApiEndpoint.get("getWalletSummary", "/api/wallets/:walletId/summary", {
      params: walletIdParam,
      success: WalletSummaryResponse,
      error: WalletNotFoundProblem
    })
  );
