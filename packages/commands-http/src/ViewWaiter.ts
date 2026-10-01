import type { Duration, Effect } from "effect";
import type { SqlClient } from "effect/sql";
import type { SqlError } from "effect/sql/SqlError";

// What the command API needs to know about a view in order to let a request wait for it ("read your own
// writes", see @crablet/views/WaitUntilProcessed): a function that resolves once the view has caught up to a
// write (a log position and the transaction that appended it). The app supplies one per view name; this package never imports the views package, it only
// needs the function and the two outcomes it distinguishes (the failure shapes below are structurally the ones
// `waitUntilProcessed` fails with, so it can be passed as is):
//
//     viewWaiters: {
//       "wallet-balance-view": (write, { timeout }) => waitUntilProcessed(walletBalanceViewSubscription, write, { timeout })
//     }
export interface ViewWaitTimeout {
  readonly _tag: "WaitTimeout";
  readonly reached: bigint;
}
export interface ViewWaitFailed {
  readonly _tag: "ViewFailed";
}
// The point in the log a command's events reached. Structurally a ProgressCursor of the pollers.
export interface WriteMarker {
  readonly transactionId: string;
  readonly position: bigint;
}
export type ViewWaiter = (
  write: WriteMarker,
  options: { readonly timeout: Duration.Duration }
) => Effect.Effect<void, ViewWaitTimeout | ViewWaitFailed | SqlError, SqlClient.SqlClient>;

export const defaultWaitTimeoutMs = 5_000;
export const maxWaitTimeoutMs = 30_000;
