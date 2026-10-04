import { Duration, Effect } from "effect";
import type { SqlClient } from "effect/sql";
import type { SqlError } from "effect/sql/SqlError";
import type { ProgressCursor } from "@crablet/event-poller/ProgressCursor";
import type { ViewSubscription } from "@crablet/views/ViewSubscription";
import { ViewFailed, WaitTimeout, waitUntilProcessed } from "@crablet/views/WaitUntilProcessed";

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

// One view's wait. The real one is `waitUntilProcessed` (it reads the database, so it needs a SqlClient); tests pass fakes that need nothing.
export type ViewWait<R = SqlClient.SqlClient> = (
  subscription: ViewSubscription,
  write: ProgressCursor,
  options: { readonly timeout?: Duration.Input }
) => Effect.Effect<void, WaitTimeout | ViewFailed | SqlError, R>;

// Wait until EVERY view has caught up to `write`, or the timeout passes. The views are waited for at the same time, so the one timeout is a
// shared deadline: the whole wait takes at most `timeoutMs`, not that long per view. Every view's outcome is collected (the first
// failure does not stop the others), so the answer can name each view that is behind. A database error is not a verdict about the views:
// it fails the wait.
export const waitForViews = <R = SqlClient.SqlClient>(
  subscriptions: ReadonlyArray<ViewSubscription>,
  write: ProgressCursor,
  timeoutMs: number,
  wait: ViewWait<R> = waitUntilProcessed as unknown as ViewWait<R>
): Effect.Effect<ViewsOutcome, SqlError, R> =>
  Effect.gen(function* () {
    const outcomes = yield* Effect.forEach(
      subscriptions,
      (subscription) =>
        wait(subscription, write, { timeout: Duration.millis(timeoutMs) }).pipe(
          Effect.as(null),
          Effect.catchTag("WaitTimeout", (e) =>
            Effect.succeed<UncaughtView>({ name: subscription.viewName, reason: "lagging", reachedPosition: String(e.reached) })
          ),
          Effect.catchTag("ViewFailed", () =>
            Effect.succeed<UncaughtView>({ name: subscription.viewName, reason: "view_failed", reachedPosition: null })
          )
        ),
      { concurrency: "unbounded" }
    );
    const behind = outcomes.filter((o): o is UncaughtView => o !== null);
    if (behind.length === 0) return { _tag: "CaughtUp" } as const;
    return {
      _tag: "NotCaughtUp",
      reason: behind.some((v) => v.reason === "view_failed") ? "view_failed" : "lagging",
      views: behind
    } as const;
  });
