import * as Schema from "effect/Schema";
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "@effect/platform";
import { WalletNotFoundProblem } from "./WalletProblems.ts";

// Port of com.crablet.wallet.api.WalletQueryController - hand-written reads (plain SqlClient
// queries against the view tables, no event-store involvement), composed alongside
// commands-http's generic write group under one shared HttpApi (see WalletApp.ts).
export const WalletResponse = Schema.Struct({
  walletId: Schema.String,
  owner: Schema.String,
  balance: Schema.Number,
  lastUpdatedAt: Schema.String
});

export const TransactionResponse = Schema.Struct({
  transactionId: Schema.String,
  walletId: Schema.String,
  eventType: Schema.String,
  amount: Schema.Number,
  description: Schema.String,
  occurredAt: Schema.String
});

export const TransactionsResponse = Schema.Struct({
  transactions: Schema.Array(TransactionResponse)
});

export const WalletSummaryResponse = Schema.Struct({
  walletId: Schema.String,
  totalDeposits: Schema.Number,
  totalWithdrawals: Schema.Number,
  totalTransfersIn: Schema.Number,
  totalTransfersOut: Schema.Number,
  currentBalance: Schema.Number,
  lastTransactionAt: Schema.NullOr(Schema.String)
});

export const TransactionsPageParams = Schema.Struct({
  page: Schema.optional(Schema.NumberFromString),
  size: Schema.optional(Schema.NumberFromString)
});

export const walletQueryGroup = HttpApiGroup.make("walletQueries")
  .add(
    HttpApiEndpoint.get("getWallet")`/api/wallets/${HttpApiSchema.param("walletId", Schema.String)}`
      .addSuccess(WalletResponse)
      .addError(WalletNotFoundProblem)
  )
  .add(
    HttpApiEndpoint.get("getWalletTransactions")`/api/wallets/${HttpApiSchema.param("walletId", Schema.String)}/transactions`
      .setUrlParams(TransactionsPageParams)
      .addSuccess(TransactionsResponse)
      .addError(WalletNotFoundProblem)
  )
  .add(
    HttpApiEndpoint.get("getWalletSummary")`/api/wallets/${HttpApiSchema.param("walletId", Schema.String)}/summary`
      .addSuccess(WalletSummaryResponse)
      .addError(WalletNotFoundProblem)
  );
