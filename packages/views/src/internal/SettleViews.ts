import { Duration, Effect } from "effect";
import type { SqlError } from "effect/sql/SqlError";
import * as ProgressCursorNS from "@crablet/event-poller/ProgressCursor";
import type { ProgressCursor } from "@crablet/event-poller/ProgressCursor";
import type { SettleViews, UncaughtView } from "../SettleViews.ts";
import type { ViewSubscription } from "../ViewSubscription.ts";
import type { ViewFailed, WaitTimeout } from "../WaitUntilProcessed.ts";
import type { ReadCheckResult } from "./ReadCheck.ts";
import { viewVerdict } from "./ViewVerdict.ts";

// `settleViews` over its two looks at the database: the first look for every view (`readCheck`) and the wait for one view (`waitUntilProcessed`). Taken as parameters so the
// rules between them (which views wait, the shared deadline, what the outcome lists) are tested without a database; `settleViews` is this with the real ones.
export interface SettleDeps<R> {
  readonly check: (subscriptions: ReadonlyArray<ViewSubscription>, marker: ProgressCursor | null) => Effect.Effect<ReadCheckResult, SqlError, R>;
  readonly wait: (
    subscription: ViewSubscription,
    write: ProgressCursor,
    options: { readonly timeout?: Duration.Input }
  ) => Effect.Effect<void, WaitTimeout | ViewFailed | SqlError, R>;
}

export const makeSettleViews =
  <R>(deps: SettleDeps<R>): SettleViews<R> =>
  (subscriptions, marker, timeoutMs) =>
    Effect.gen(function* () {
      const first = yield* deps.check(subscriptions, marker);
      if (marker !== null && ProgressCursorNS.compare(marker, first.head) > 0) return { _tag: "Beyond", head: first.head } as const;
      const write = marker ?? first.head;
      // One entry per subscription, by position. The views are waited for at the same time, so the one timeout is a shared deadline: the whole wait takes at most `timeoutMs`,
      // not that long per view. Every view's outcome is collected (the first failure does not stop the others), so the answer can name each view that is behind.
      const outcomes = yield* Effect.forEach(
        subscriptions,
        (subscription, index) => {
          // The first look gives one entry per subscription; were one missing, the view is waited for rather than judged on nothing.
          const view = first.views[index];
          const verdict = view === undefined ? "wait" : viewVerdict(write, view.cursor, view.status, view.pending);
          if (verdict === "caught_up") return Effect.succeed(null);
          if (verdict === "failed") return Effect.succeed<UncaughtView>({ name: subscription.viewName, reason: "view_failed", reachedPosition: null });
          return deps.wait(subscription, write, { timeout: Duration.millis(timeoutMs) }).pipe(
            Effect.as(null),
            Effect.catchTag("WaitTimeout", (e) =>
              Effect.succeed<UncaughtView>({ name: subscription.viewName, reason: "lagging", reachedPosition: String(e.reached) })
            ),
            Effect.catchTag("ViewFailed", () => Effect.succeed<UncaughtView>({ name: subscription.viewName, reason: "view_failed", reachedPosition: null }))
          );
        },
        { concurrency: "unbounded" }
      );
      const behind = outcomes.filter((o): o is UncaughtView => o !== null);
      if (behind.length === 0) return { _tag: "Settled", outcome: { _tag: "CaughtUp" } } as const;
      return {
        _tag: "Settled",
        outcome: { _tag: "NotCaughtUp", reason: behind.some((v) => v.reason === "view_failed") ? "view_failed" : "lagging", views: behind }
      } as const;
    });
