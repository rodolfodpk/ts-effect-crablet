import * as Schema from "effect/Schema";
import { HttpApiEndpoint, HttpApiGroup } from "effect/http-api";
import { ReadSuccess, consistencyQuery, readProblems } from "@crablet/views-http/ReadQuery";
import { WalletNotFoundProblem } from "./WalletProblems.ts";
import { defaultPageSize, maxPageSize } from "./TransactionPaging.ts";

// Every read takes the consistency parameters (`consistentWith`, `consistency`, `waitTimeout`) and can answer 400 and 503 besides its own
// errors; a client resolves each to `{ body, headers }` (`ReadSuccess`; the header marks a stale answer). See @crablet/views-http.
// Hand-written reads (plain SqlClient
// queries against the view tables, no event-store involvement), composed alongside
// commands-http's generic write group under one shared HttpApi (see WalletApp.ts).
export const WalletResponse = Schema.Struct({
  walletId: Schema.String,
  owner: Schema.String,
  balance: Schema.Finite,
  lastUpdatedAt: Schema.String
});

// One page of wallets, ordered by walletId. `next` is the cursor of the following page, or null on the last one; pass it back as `after`.
export const WalletsResponse = Schema.Struct({
  wallets: Schema.Array(WalletResponse),
  next: Schema.NullOr(Schema.String)
});

export const TransactionResponse = Schema.Struct({
  transactionId: Schema.String,
  walletId: Schema.String,
  eventType: Schema.String,
  amount: Schema.Finite,
  description: Schema.String,
  occurredAt: Schema.String
});

// One page of a wallet's transactions, newest first. `next` is the cursor of the following page, or null on the last one; pass it back as `after`.
export const TransactionsResponse = Schema.Struct({
  transactions: Schema.Array(TransactionResponse),
  next: Schema.NullOr(Schema.String)
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

// Query-string params for the transactions list. Plain strings on purpose: the handler validates them (so a bad value answers with the same
// problem body as every other 400 instead of the HTTP framework's empty-bodied default); the allowed values are in the descriptions.
export const TransactionsPageParams = {
  limit: Schema.optionalKey(
    Schema.String.annotate({ description: `How many transactions to return: a whole number from 1 to ${maxPageSize} (default ${defaultPageSize}).` } as never)
  ),
  after: Schema.optionalKey(
    Schema.String.annotate({ description: "Return the transactions after this cursor: the `next` of the previous page. Opaque to clients." } as never)
  )
};

// Query-string params for the wallet list, plain strings for the same reason as the transactions'.
export const WalletsPageParams = {
  limit: Schema.optionalKey(
    Schema.String.annotate({ description: `How many wallets to return: a whole number from 1 to ${maxPageSize} (default ${defaultPageSize}).` } as never)
  ),
  after: Schema.optionalKey(
    Schema.String.annotate({ description: "Return the wallets after this cursor: the `next` of the previous page. Opaque to clients." } as never)
  )
};

const walletIdParam = { walletId: Schema.String };

export const walletQueryGroup = HttpApiGroup.make("walletQueries")
  .add(
    HttpApiEndpoint.get("listWallets", "/api/wallets", {
      query: { ...WalletsPageParams, ...consistencyQuery },
      success: ReadSuccess(WalletsResponse),
      error: readProblems
    })
  )
  .add(
    HttpApiEndpoint.get("getWallet", "/api/wallets/:walletId", {
      params: walletIdParam,
      query: consistencyQuery,
      success: ReadSuccess(WalletResponse),
      error: [WalletNotFoundProblem, ...readProblems]
    })
  )
  .add(
    HttpApiEndpoint.get("getWalletTransactions", "/api/wallets/:walletId/transactions", {
      params: walletIdParam,
      query: { ...TransactionsPageParams, ...consistencyQuery },
      success: ReadSuccess(TransactionsResponse),
      error: [WalletNotFoundProblem, ...readProblems]
    })
  )
  .add(
    HttpApiEndpoint.get("getWalletSummary", "/api/wallets/:walletId/summary", {
      params: walletIdParam,
      query: consistencyQuery,
      success: ReadSuccess(WalletSummaryResponse),
      error: [WalletNotFoundProblem, ...readProblems]
    })
  );
