import { Clock, Data, Duration, Effect } from "effect";
import { SqlClient } from "effect/sql";
import type { SqlError } from "effect/sql/SqlError";
import { hasPendingSelectedEvents } from "@crablet/event-poller/SqlEventFetcher";
import type { ViewSubscription } from "./ViewSubscription.ts";

// Read your own writes from an asynchronous view.
//
// Views are updated by a background processor, a little after the events they project are appended. A
// caller that just ran a command and now wants to read the view (say, the HTTP response that shows the
// new balance) would otherwise see the old state. The command's result carries the log position its
// events reached (`ExecutionResult.lastPosition`); this waits until the view's progress has passed it.
//
//     const result = yield* executor.run(Deposit, input);
//     yield* waitUntilProcessed(walletBalanceViewSubscription, result.lastPosition);
//     // ... the view now includes that deposit
//
// `position` is null when the run appended nothing (an idempotent repeat): there is nothing to wait for.
//
// "Caught up to position p" does NOT mean the view's progress equals p: a view's progress only lands on
// events its subscription matches, so a command whose last event the view ignores would never reach p.
// The view has caught up when its progress has passed p OR no event its subscription matches remains in
// (progress, p]. That is why this takes the subscription, not just the view's name.
//
// The wait polls. It fails with `WaitTimeout` if the view has not caught up in time (it may be paused,
// lagging, or not running at all) and fails fast with `ViewFailed` if the view has been marked FAILED,
// since it will not progress until someone resets it.

export class WaitTimeout extends Data.TaggedError("WaitTimeout")<{
  readonly message: string;
  readonly viewName: string;
  // The position being waited for, and how far the view had got when the wait gave up.
  readonly position: bigint;
  readonly reached: bigint;
}> {}

export class ViewFailed extends Data.TaggedError("ViewFailed")<{
  readonly message: string;
  readonly viewName: string;
}> {}

export interface WaitOptions {
  // How long to wait before giving up (default 5 seconds).
  readonly timeout?: Duration.Input;
  // How often to look at the view's progress (default 25 ms).
  readonly interval?: Duration.Input;
}

export const waitUntilProcessed = (
  subscription: ViewSubscription,
  position: bigint | null,
  options: WaitOptions = {}
): Effect.Effect<void, WaitTimeout | ViewFailed | SqlError, SqlClient.SqlClient> =>
  Effect.gen(function* () {
    if (position === null) return;
    const viewName = subscription.viewName;
    const sql = yield* SqlClient.SqlClient;
    const timeoutMs = Duration.toMillis(Duration.fromInputUnsafe(options.timeout ?? "5 seconds"));
    const interval = Duration.fromInputUnsafe(options.interval ?? "25 millis");
    const startedAt = yield* Clock.currentTimeMillis;

    for (;;) {
      // last_position is BIGINT; read it as text and convert, as everywhere else in this repo
      const rows = yield* sql.unsafe<{ last_position: string; status: string }>(
        "SELECT last_position::text AS last_position, status FROM crablet_view_progress WHERE view_name = $1",
        [viewName]
      );
      const reached = rows[0] === undefined ? 0n : BigInt(rows[0].last_position);
      if (reached >= position) return;
      if (!(yield* hasPendingSelectedEvents(subscription, reached, position))) return;
      if (rows[0]?.status === "FAILED") {
        return yield* new ViewFailed({ message: `View "${viewName}" is FAILED and will not progress`, viewName });
      }
      const elapsed = (yield* Clock.currentTimeMillis) - startedAt;
      if (elapsed >= timeoutMs) {
        return yield* new WaitTimeout({
          message: `View "${viewName}" had only reached position ${reached} after ${elapsed} ms (waiting for ${position})`,
          viewName,
          position,
          reached
        });
      }
      yield* Effect.sleep(interval);
    }
  });
