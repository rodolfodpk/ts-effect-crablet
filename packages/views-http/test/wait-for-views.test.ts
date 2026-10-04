import { describe, expect, it } from "bun:test";
import { Deferred, Duration, Effect, Exit } from "effect";
import { viewSubscriptionOf } from "@crablet/views/ViewSubscription";
import { ViewFailed, WaitTimeout } from "@crablet/views/WaitUntilProcessed";
import * as ProgressCursor from "@crablet/event-poller/ProgressCursor";
import { waitForViews, type ViewWait } from "../src/WaitForViews.ts";

const view = (name: string) => viewSubscriptionOf(name, { eventTypes: new Set(["E"]) });
const write = ProgressCursor.of("7421", 98213n);

const caughtUp: ViewWait<never> = () => Effect.void;
const timedOut = (reached: bigint): ViewWait<never> => (subscription) =>
  Effect.fail(new WaitTimeout({ message: "late", viewName: subscription.viewName, position: write.position, reached }));
const failed: ViewWait<never> = (subscription) => Effect.fail(new ViewFailed({ message: "failed", viewName: subscription.viewName }));

// A fake waiter that decides per view name.
const byView = (waits: Record<string, ViewWait<never>>): ViewWait<never> => (subscription, cursor, options) => waits[subscription.viewName]!(subscription, cursor, options);

const run = <A, E>(effect: Effect.Effect<A, E, never>) => Effect.runPromise(effect);

describe("waitForViews", () => {
  it("has nothing to wait for when no view is read", async () => {
    expect(await run(waitForViews([], write, 1000, () => Effect.die("must not be called")))).toEqual({ _tag: "CaughtUp" });
  });

  it("is caught up when every view is, and gives each the same write and the same timeout", async () => {
    const calls: Array<{ view: string; cursor: ProgressCursor.ProgressCursor; ms: number }> = [];
    const wait: ViewWait<never> = (subscription, cursor, options) => {
      calls.push({ view: subscription.viewName, cursor, ms: Duration.toMillis(Duration.fromInputUnsafe(options.timeout!)) });
      return Effect.void;
    };
    expect(await run(waitForViews([view("a"), view("b"), view("c")], write, 2500, wait))).toEqual({ _tag: "CaughtUp" });
    expect(calls.map((c) => c.view).sort()).toEqual(["a", "b", "c"]);
    for (const call of calls) {
      expect(call.cursor).toEqual(write);
      expect(call.ms).toBe(2500);
    }
  });

  it("names only the views that did not catch up, with how far each got", async () => {
    const outcome = await run(waitForViews([view("a"), view("b"), view("c")], write, 1000, byView({ a: caughtUp, b: timedOut(97000n), c: caughtUp })));
    expect(outcome).toEqual({
      _tag: "NotCaughtUp",
      reason: "lagging",
      views: [{ name: "b", reason: "lagging", reachedPosition: "97000" }]
    });
  });

  it("collects EVERY view that did not catch up, in the order they were given, not just the first to fail", async () => {
    const outcome = await run(waitForViews([view("a"), view("b"), view("c")], write, 1000, byView({ a: timedOut(1n), b: caughtUp, c: timedOut(3n) })));
    expect(outcome).toEqual({
      _tag: "NotCaughtUp",
      reason: "lagging",
      views: [
        { name: "a", reason: "lagging", reachedPosition: "1" },
        { name: "c", reason: "lagging", reachedPosition: "3" }
      ]
    });
  });

  it("a failed view makes the whole answer view_failed, and is listed with the lagging ones", async () => {
    const outcome = await run(waitForViews([view("a"), view("b")], write, 1000, byView({ a: timedOut(5n), b: failed })));
    expect(outcome).toEqual({
      _tag: "NotCaughtUp",
      reason: "view_failed",
      views: [
        { name: "a", reason: "lagging", reachedPosition: "5" },
        { name: "b", reason: "view_failed", reachedPosition: null }
      ]
    });
  });

  it("waits for the views at the same time (one slow view does not delay the start of the others)", async () => {
    // Sequentially this deadlocks: `first` cannot finish until `second` has STARTED.
    const program = Effect.gen(function* () {
      const secondStarted = yield* Deferred.make<void>();
      const wait = byView({
        first: () => Deferred.await(secondStarted),
        second: () => Deferred.succeed(secondStarted, undefined).pipe(Effect.asVoid)
      });
      return yield* waitForViews([view("first"), view("second")], write, 1000, wait);
    }).pipe(Effect.timeout("2 seconds"));
    expect(await run(program)).toEqual({ _tag: "CaughtUp" });
  });

  it("fails with the database error, not with a verdict about the views", async () => {
    const dbError = { _tag: "SqlError", message: "connection lost" };
    const exit = await Effect.runPromiseExit(waitForViews([view("a")], write, 1000, () => Effect.fail(dbError as never)));
    expect(Exit.isFailure(exit)).toBe(true);
    expect(JSON.stringify(exit)).toContain("connection lost");
  });
});
