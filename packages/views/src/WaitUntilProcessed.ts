import { Clock, Data, Duration, Effect, Option } from "effect";
import { SqlClient } from "effect/sql";
import type { SqlError } from "effect/sql/SqlError";
import { hasPendingSelectedEvents } from "@crablet/event-poller/SqlEventFetcher";
import * as ProgressCursorNS from "@crablet/event-poller/ProgressCursor";
import type { ProgressCursor } from "@crablet/event-poller/ProgressCursor";
import type { ViewSubscription } from "./ViewSubscription.ts";
import { ViewProgressHub } from "./ViewProgressHub.ts";
import { viewVerdict } from "./ViewVerdict.ts";

// Read your own writes from an asynchronous view.
//
// Views are updated by a background processor, a little after the events they project are appended. A
// caller that just ran a command and now wants to read the view (say, the HTTP response that shows the
// new balance) would otherwise see the old state. The command's result carries the point in the log its
// events reached (`ExecutionResult.lastPosition` and `lastTransactionId`); this waits until the view's progress
// has passed it.
//
//     const result = yield* executor.run(Deposit, input);
//     yield* waitUntilProcessed(walletBalanceViewSubscription, { transactionId: result.lastTransactionId!, position: result.lastPosition! });
//     // ... the view now includes that deposit
//
// `write` is null when the run appended nothing (an idempotent repeat): there is nothing to wait for.
//
// Progress and the write are both (transaction_id, position) pairs, compared in that order: a view's cursor
// can sit at a HIGHER position than the write and still not have processed it (the write's transaction took a
// lower xid but its position came later), so positions alone prove nothing.
//
// "Caught up to the write" does NOT mean the view's progress equals it: a view's progress only lands on
// events its subscription matches, so a command whose last event the view ignores would never reach it.
// The view has caught up when its progress has passed the write OR no event its subscription matches remains in
// (progress, write]. That is why this takes the subscription, not just the view's name.
//
// The wait polls, or - when a `ViewProgressHub` is in the context (ADR-0016) - is woken by the view's progress ping and looks only on a ping, on a
// reconnect of the hub, on a safety interval and at the deadline. It fails with `WaitTimeout` if the view has not caught up in time (it may be paused,
// lagging, or not running at all) and fails fast with `ViewFailed` if the view has been marked FAILED,
// since it will not progress until someone resets it.

export class WaitTimeout extends Data.TaggedError("WaitTimeout")<{
  readonly message: string;
  readonly viewName: string;
  // The position being waited for, and the position of the view's cursor when the wait gave up.
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
  // How often to look at the view's progress when polling (default 25 ms): with no hub, or while the hub's LISTEN is down.
  readonly interval?: Duration.Input;
  // With a hub, how long to wait for a ping before looking anyway (default 1 second): the net for a ping that was lost. A ping, a reconnect of the
  // hub and the deadline each end the pause sooner.
  readonly safetyInterval?: Duration.Input;
}

export const waitUntilProcessed = (
  subscription: ViewSubscription,
  write: ProgressCursor | null,
  options: WaitOptions = {}
): Effect.Effect<void, WaitTimeout | ViewFailed | SqlError, SqlClient.SqlClient> =>
  Effect.gen(function* () {
    if (write === null) return;
    const viewName = subscription.viewName;
    const sql = yield* SqlClient.SqlClient;
    const timeoutMs = Duration.toMillis(Duration.fromInputUnsafe(options.timeout ?? "5 seconds"));
    const interval = Duration.fromInputUnsafe(options.interval ?? "25 millis");
    const safetyMs = Duration.toMillis(Duration.fromInputUnsafe(options.safetyInterval ?? "1 second"));
    const startedAt = yield* Clock.currentTimeMillis;

    // Look at the view; end the wait if it has the write, is failed, or time ran out; otherwise `pause` and look again. `pause` gets the time left and
    // says whether, while it paused, the view was reported to have reached the write (a ping whose cursor covers it): then the wait is over without another look.
    const loop = (pause: (remainingMs: number) => Effect.Effect<boolean>) =>
      Effect.gen(function* () {
        for (;;) {
          // last_position is BIGINT and last_transaction_id XID8; read both as text and convert
          const rows = yield* sql.unsafe<{ last_position: string; last_transaction_id: string; status: string }>(
            "SELECT last_position::text AS last_position, last_transaction_id::text AS last_transaction_id, status FROM crablet_view_progress WHERE view_name = $1",
            [viewName]
          );
          const cursor =
            rows[0] === undefined
              ? ProgressCursorNS.zero
              : ProgressCursorNS.of(rows[0].last_transaction_id, BigInt(rows[0].last_position));
          const reached = cursor.position;
          // `pending` is only asked while the view is behind the write (the verdict ignores it otherwise)
          const pending = ProgressCursorNS.compare(cursor, write) >= 0 ? false : yield* hasPendingSelectedEvents(subscription, cursor, write);
          const verdict = viewVerdict(write, cursor, rows[0]?.status ?? null, pending);
          if (verdict === "caught_up") return;
          if (verdict === "failed") {
            return yield* new ViewFailed({ message: `View "${viewName}" is FAILED and will not progress`, viewName });
          }
          const elapsed = (yield* Clock.currentTimeMillis) - startedAt;
          if (elapsed >= timeoutMs) {
            return yield* new WaitTimeout({
              message: `View "${viewName}" had only reached position ${reached} after ${elapsed} ms (waiting for ${write.position})`,
              viewName,
              position: write.position,
              reached
            });
          }
          if (yield* pause(timeoutMs - elapsed)) return;
        }
      });

    // With a hub in the context the wait is woken by the view's progress ping (ADR-0016): subscribe BEFORE the first look, so a ping that arrives
    // meanwhile is already waiting for us, then look, and between looks wait for a ping, a reconnect of the hub, the safety interval or the
    // deadline, whichever comes first. With no hub, or while its LISTEN is down, poll every `interval`, exactly as before.
    const hub = yield* Effect.serviceOption(ViewProgressHub);
    if (Option.isNone(hub)) return yield* loop(() => Effect.as(Effect.sleep(interval), false));
    const progress = hub.value;
    return yield* Effect.scoped(
      Effect.gen(function* () {
        const pings = yield* progress.subscribe(new Set([viewName]));
        return yield* loop((remainingMs) =>
          Effect.flatMap(progress.connected, (connected) =>
            connected
              ? Effect.map(
                  Effect.timeoutOption(pings.next, Duration.millis(Math.max(1, Math.min(safetyMs, remainingMs)))),
                  // A ping is sent in the same statement that moves the view's progress, so once it is delivered the progress has committed: a ping that
                  // covers the write IS the answer, and the waiters a ping wakes do not all run a query at the same moment. After a resync (a ping may
                  // have been lost), or with a ping that does not cover the write, look at the table.
                  (batch) =>
                    Option.isSome(batch) &&
                    !batch.value.resync &&
                    batch.value.pings.some((ping) => ping.id === viewName && ProgressCursorNS.compare(ProgressCursorNS.of(ping.transactionId, BigInt(ping.position)), write) >= 0)
                )
              : Effect.as(Effect.sleep(interval), false)
          )
        );
      })
    );
  });
