import * as Schema from "effect/Schema";
import { HttpApiSchema } from "@effect/platform";

// App-owned RFC 7807 wire types, same plain-Schema.Class pattern (not Schema.TaggedError -
// confirmed during commands-http's own Phase 7 spike that tagging leaks an unwanted `_tag` field)
// @crablet/commands-http/ProblemDetail.ts establishes. Used both by WalletQueryApiLive.ts's direct
// 404s and by WalletApp.ts's ExposedCommand.mapError hooks, translating the domain errors thrown
// by command handlers (WalletNotFound/InsufficientFunds) into these same wire shapes.
export class WalletNotFoundProblem extends Schema.Class<WalletNotFoundProblem>("WalletNotFoundProblem")(
  {
    type: Schema.Literal("urn:wallet-example-app:problem:wallet-not-found"),
    title: Schema.Literal("Not Found"),
    status: Schema.Literal(404),
    detail: Schema.String
  },
  HttpApiSchema.annotations({ status: 404 })
) {
  static of(walletId: string): WalletNotFoundProblem {
    return new WalletNotFoundProblem({
      type: "urn:wallet-example-app:problem:wallet-not-found",
      title: "Not Found",
      status: 404,
      detail: `Wallet not found: ${walletId}`
    });
  }
}

export class InsufficientFundsProblem extends Schema.Class<InsufficientFundsProblem>("InsufficientFundsProblem")(
  {
    type: Schema.Literal("urn:wallet-example-app:problem:insufficient-funds"),
    title: Schema.Literal("Bad Request"),
    status: Schema.Literal(400),
    detail: Schema.String,
    currentBalance: Schema.Number,
    requestedAmount: Schema.Number
  },
  HttpApiSchema.annotations({ status: 400 })
) {
  static of(walletId: string, currentBalance: number, requestedAmount: number): InsufficientFundsProblem {
    return new InsufficientFundsProblem({
      type: "urn:wallet-example-app:problem:insufficient-funds",
      title: "Bad Request",
      status: 400,
      detail: `Wallet ${walletId} has insufficient funds: balance ${currentBalance}, requested ${requestedAmount}`,
      currentBalance,
      requestedAmount
    });
  }
}
