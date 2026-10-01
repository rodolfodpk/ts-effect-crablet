import * as Schema from "effect/Schema";
import "effect/http-api"; // registers the `httpApiStatus` schema annotation used below

// App-owned RFC 7807 wire types, same plain-Schema.Class pattern (not Schema.TaggedError -
// confirmed during commands-http's own Phase 7 spike that tagging leaks an unwanted `_tag` field)
// @crablet/commands-http/ProblemDetail.ts establishes. Used by WalletQueryApiLive.ts's direct 404s on
// the read endpoints. (The write API presents the commands' domain errors by their kind, see WalletApp.ts.)
export class WalletNotFoundProblem extends Schema.Class<WalletNotFoundProblem>("WalletNotFoundProblem")(
  {
    type: Schema.Literal("urn:wallet-example-app:problem:wallet-not-found"),
    title: Schema.Literal("Not Found"),
    status: Schema.Literal(404),
    detail: Schema.String
  },
  { httpApiStatus: 404 }
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
