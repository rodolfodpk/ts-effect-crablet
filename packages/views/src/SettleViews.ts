import type { Effect } from "effect";
import type { SqlClient } from "effect/sql";
import type { SqlError } from "effect/sql/SqlError";
import type { ProgressCursor } from "@crablet/event-poller/ProgressCursor";
import type { ViewSubscription } from "./ViewSubscription.ts";
import { waitUntilProcessed } from "./WaitUntilProcessed.ts";
import { readCheck } from "./internal/ReadCheck.ts";
import { makeSettleViews } from "./internal/SettleViews.ts";

// Have the views a read uses caught up with a write? The whole wait of a consistent read (ADR-0015), behind one call:
//
//   1. one statement says where the log ends and, for each view, where it is and whether anything it handles is pending up to the write (`marker`, or the end of the log when null);
//   2. a marker beyond the end of the log is `Beyond`: it can only be forged or from another log, and nothing waits;
//   3. a view that has caught up is not waited for, one that is FAILED is reported at once, and the others are waited for at the same time (`waitUntilProcessed`, woken by the
//      view progress hub when one is in the context), with `timeoutMs` as one shared deadline;
//   4. the outcome names every view that had not caught up, in the order given (the same view twice gives two entries).
//
// No views: only step 2, and the outcome is `CaughtUp`. A database error is not a verdict about the views: it fails the effect.

// One view that had not caught up when the wait ended: which, why, and how far its progress had got (a log position; null for a view
// that is FAILED, which is not progressing and was not asked how far it got).
export interface UncaughtView {
  readonly name: string;
  readonly reason: "lagging" | "view_failed";
  readonly reachedPosition: string | null;
}

export type ViewsOutcome =
  | { readonly _tag: "CaughtUp" }
  // `reason` is the verdict on the whole read: view_failed if ANY view is FAILED (it will not recover until someone resets it, so
  // retrying is pointless), lagging otherwise (it is only behind).
  | { readonly _tag: "NotCaughtUp"; readonly reason: "lagging" | "view_failed"; readonly views: ReadonlyArray<UncaughtView> };

export type Settlement =
  | { readonly _tag: "Beyond"; readonly head: ProgressCursor }
  | { readonly _tag: "Settled"; readonly outcome: ViewsOutcome };

// The shape of `settleViews`, for a caller that takes it as a dependency (the read wrapper's tests pass fakes that need no database).
export type SettleViews<R = SqlClient.SqlClient> = (
  subscriptions: ReadonlyArray<ViewSubscription>,
  marker: ProgressCursor | null,
  timeoutMs: number
) => Effect.Effect<Settlement, SqlError, R>;

export const settleViews: SettleViews = makeSettleViews({ check: readCheck, wait: waitUntilProcessed });
