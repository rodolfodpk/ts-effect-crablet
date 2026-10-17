import { describe, expect, it } from "bun:test";
import { Deferred, Duration, Effect, Exit } from "effect";
import * as ProgressCursor from "@crablet/event-poller/ProgressCursor";
import { viewSubscriptionOf } from "../src/ViewSubscription.ts";
import { ViewFailed, WaitTimeout } from "../src/WaitUntilProcessed.ts";
import type { ReadCheckResult } from "../src/internal/ReadCheck.ts";
import type { Settlement } from "../src/SettleViews.ts";
import { makeSettleViews, type SettleDeps } from "../src/internal/SettleViews.ts";

// The rules of `settleViews` between its two looks at the database, over fakes of both: the first look (`readCheck`) and the wait for one view (`waitUntilProcessed`).
// That the real looks give the verdicts the fakes stand for is tested against Postgres (integration/read-check.test.ts, integration/settle-views.test.ts).
const view = (name: string) => viewSubscriptionOf(name, { eventTypes: new Set(["E"]) });
const head = ProgressCursor.of("7421", 98213n);
const ahead = (cursor: ProgressCursor.ProgressCursor) => ({ cursor, status: "ACTIVE" as string | null, pending: false });
const atHead = ahead(head);
const behind = { cursor: ProgressCursor.of("7421", 10n), status: "ACTIVE" as string | null, pending: true };
const failedAndPending = { cursor: ProgressCursor.of("7421", 10n), status: "FAILED" as string | null, pending: true };

type Wait = SettleDeps<never>["wait"];
const timedOut = (reached: bigint): Wait => (subscription, cursor) =>
  Effect.fail(new WaitTimeout({ message: "late", viewName: subscription.viewName, position: cursor.position, reached }));
const viewFailed: Wait = (subscription) => Effect.fail(new ViewFailed({ message: "failed", viewName: subscription.viewName }));

const harness = (options: { readonly result: ReadCheckResult; readonly waits?: Record<string, Wait> }) => {
  const calls = {
    checks: [] as Array<{ views: string[]; marker: ProgressCursor.ProgressCursor | null }>,
    waits: [] as Array<{ view: string; cursor: ProgressCursor.ProgressCursor; ms: number }>
  };
  const settle = makeSettleViews<never>({
    check: (subscriptions, marker) => Effect.sync(() => (calls.checks.push({ views: subscriptions.map((s) => s.viewName), marker }), options.result)),
    wait: (subscription, cursor, opts) => {
      calls.waits.push({ view: subscription.viewName, cursor, ms: Duration.toMillis(Duration.fromInputUnsafe(opts.timeout!)) });
      return (options.waits?.[subscription.viewName] ?? (() => Effect.void))(subscription, cursor, opts);
    }
  });
  return { calls, settle };
};
const run = <A, E>(effect: Effect.Effect<A, E, never>) => Effect.runPromise(effect);
const caughtUp: Settlement = { _tag: "Settled", outcome: { _tag: "CaughtUp" } };

describe("the first look", () => {
  it("every view already at the head: one check, no wait", async () => {
    const h = harness({ result: { head, views: [atHead] } });
    expect(await run(h.settle([view("balance")], null, 5000))).toEqual(caughtUp);
    expect(h.calls.checks).toEqual([{ views: ["balance"], marker: null }]);
    expect(h.calls.waits).toEqual([]);
  });

  it("a view behind with nothing of its own pending needs no wait either (the write is an event it does not handle)", async () => {
    const h = harness({ result: { head, views: [{ ...behind, pending: false }] } });
    expect(await run(h.settle([view("balance")], null, 5000))).toEqual(caughtUp);
    expect(h.calls.waits).toEqual([]);
  });

  it("with a marker: the check gets the marker, and a view at or past it needs no wait", async () => {
    const marker = ProgressCursor.of("7000", 90000n);
    const h = harness({ result: { head, views: [ahead(marker)] } });
    expect(await run(h.settle([view("balance")], marker, 5000))).toEqual(caughtUp);
    expect(h.calls.checks).toEqual([{ views: ["balance"], marker }]);
    expect(h.calls.waits).toEqual([]);
  });
});

describe("a marker beyond the end of the log", () => {
  it("is Beyond, with the head, and nothing waits", async () => {
    const h = harness({ result: { head, views: [behind] } });
    expect(await run(h.settle([view("a")], ProgressCursor.of("9999", 99999999n), 5000))).toEqual({ _tag: "Beyond", head });
    expect(h.calls.waits).toEqual([]);
  });

  it("a marker exactly at the head is not beyond it", async () => {
    const h = harness({ result: { head, views: [atHead] } });
    expect(await run(h.settle([view("a")], head, 5000))).toEqual(caughtUp);
  });

  it("is checked with no views too", async () => {
    const h = harness({ result: { head, views: [] } });
    expect(await run(h.settle([], null, 5000))).toEqual(caughtUp);
    expect(h.calls.checks).toEqual([{ views: [], marker: null }]);
    expect((await run(h.settle([], ProgressCursor.of("9999", 99999999n), 5000)))._tag).toBe("Beyond");
  });
});

describe("the views that are behind", () => {
  it("only they wait, for the write, each with the whole timeout (a shared deadline: they wait at the same time)", async () => {
    const h = harness({ result: { head, views: [atHead, behind, behind] } });
    expect(await run(h.settle([view("a"), view("b"), view("c")], null, 750))).toEqual(caughtUp);
    expect(h.calls.waits).toEqual([
      { view: "b", cursor: head, ms: 750 },
      { view: "c", cursor: head, ms: 750 }
    ]);
  });

  it("wait for the marker when there is one, not for the head", async () => {
    const marker = ProgressCursor.of("7000", 90000n);
    // behind the MARKER (an earlier transaction id: the cursor orders by it first), and pending
    const behindTheMarker = { cursor: ProgressCursor.of("6000", 10n), status: "ACTIVE" as string | null, pending: true };
    const h = harness({ result: { head, views: [atHead, behindTheMarker] } });
    await run(h.settle([view("a"), view("b")], marker, 5000));
    expect(h.calls.waits).toEqual([{ view: "b", cursor: marker, ms: 5000 }]);
  });

  it("are matched to the first look by position, not by name (the same view read twice)", async () => {
    const h = harness({ result: { head, views: [atHead, behind] } });
    await run(h.settle([view("a"), view("a")], null, 5000));
    expect(h.calls.waits.map((w) => w.view)).toEqual(["a"]);
  });

  it("a view the first look has no entry for is waited for, not judged on nothing", async () => {
    const h = harness({ result: { head, views: [atHead] } });
    await run(h.settle([view("a"), view("b")], null, 5000));
    expect(h.calls.waits.map((w) => w.view)).toEqual(["b"]);
  });

  it("are waited for at the same time (one slow view does not delay the start of the others)", async () => {
    // Sequentially this deadlocks: `first` cannot finish until `second` has STARTED.
    const program = Effect.gen(function* () {
      const secondStarted = yield* Deferred.make<void>();
      const h = harness({
        result: { head, views: [behind, behind] },
        waits: { first: () => Deferred.await(secondStarted), second: () => Deferred.succeed(secondStarted, undefined).pipe(Effect.asVoid) }
      });
      return yield* h.settle([view("first"), view("second")], null, 1000);
    }).pipe(Effect.timeout("2 seconds"));
    expect(await run(program)).toEqual(caughtUp);
  });
});

describe("the outcome", () => {
  it("names every view that did not catch up, in the order given, with how far each got", async () => {
    const h = harness({ result: { head, views: [behind, atHead, behind] }, waits: { a: timedOut(1n), c: timedOut(3n) } });
    expect(await run(h.settle([view("a"), view("b"), view("c")], null, 1000))).toEqual({
      _tag: "Settled",
      outcome: {
        _tag: "NotCaughtUp",
        reason: "lagging",
        views: [
          { name: "a", reason: "lagging", reachedPosition: "1" },
          { name: "c", reason: "lagging", reachedPosition: "3" }
        ]
      }
    });
  });

  it("a FAILED view behind with something pending is reported at once, without a wait, and makes the whole answer view_failed", async () => {
    const h = harness({ result: { head, views: [behind, failedAndPending, atHead] }, waits: { a: timedOut(10n) } });
    expect(await run(h.settle([view("a"), view("b"), view("c")], null, 1000))).toEqual({
      _tag: "Settled",
      outcome: {
        _tag: "NotCaughtUp",
        reason: "view_failed",
        views: [
          { name: "a", reason: "lagging", reachedPosition: "10" },
          { name: "b", reason: "view_failed", reachedPosition: null }
        ]
      }
    });
    expect(h.calls.waits.map((w) => w.view)).toEqual(["a"]);
  });

  it("a view that fails while it is waited for is view_failed", async () => {
    const h = harness({ result: { head, views: [behind] }, waits: { a: viewFailed } });
    const settlement = await run(h.settle([view("a")], null, 1000));
    expect(settlement).toEqual({ _tag: "Settled", outcome: { _tag: "NotCaughtUp", reason: "view_failed", views: [{ name: "a", reason: "view_failed", reachedPosition: null }] } });
  });
});

describe("a database error is not a verdict about the views", () => {
  const dbError = { _tag: "SqlError", message: "connection lost" } as never;

  it("in the first look, it fails the effect", async () => {
    const settle = makeSettleViews<never>({ check: () => Effect.fail(dbError), wait: () => Effect.void });
    const exit = await Effect.runPromiseExit(settle([view("a")], null, 1000));
    expect(Exit.isFailure(exit)).toBe(true);
    expect(JSON.stringify(exit)).toContain("connection lost");
  });

  it("in a wait, it fails the effect", async () => {
    const h = harness({ result: { head, views: [behind] }, waits: { a: () => Effect.fail(dbError) } });
    const exit = await Effect.runPromiseExit(h.settle([view("a")], null, 1000));
    expect(Exit.isFailure(exit)).toBe(true);
    expect(JSON.stringify(exit)).toContain("connection lost");
  });
});
