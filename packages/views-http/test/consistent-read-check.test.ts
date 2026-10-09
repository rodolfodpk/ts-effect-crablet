import { describe, expect, it } from "bun:test";
import { Cause, Duration, Effect, Exit } from "effect";
import * as ProgressCursor from "@crablet/event-poller/ProgressCursor";
import { viewSubscriptionOf } from "@crablet/views/ViewSubscription";
import { ViewFailed, WaitTimeout } from "@crablet/views/WaitUntilProcessed";
import type { ReadCheckResult } from "@crablet/views/ReadCheck";
import { CommandApiBadRequest } from "@crablet/commands-http/ProblemDetail";
import { makeConsistentRead } from "../src/ConsistentRead.ts";
import { ViewsUnavailable } from "../src/ReadProblems.ts";
import { defaultReadConsistency, type ConsistencyParams, type ReadConsistencyConfig } from "../src/ReadConsistency.ts";
import type { ViewWait } from "../src/WaitForViews.ts";

// The read with a combined first look (`deps.check`): one statement says where the log ends and where each view is; only the views that are behind go on to wait.
const view = (name: string) => viewSubscriptionOf(name, { eventTypes: new Set(["E"]) });
const head = ProgressCursor.of("7421", 98213n);
const ahead = (cursor: ProgressCursor.ProgressCursor) => ({ cursor, status: "ACTIVE" as string | null, pending: false });
const atHead = ahead(head);
const behind = { cursor: ProgressCursor.of("7421", 10n), status: "ACTIVE" as string | null, pending: true };
const failedAndPending = { cursor: ProgressCursor.of("7421", 10n), status: "FAILED" as string | null, pending: true };

interface Request {
  readonly query: ConsistencyParams;
}

const harness = (options: {
  readonly config?: ReadConsistencyConfig;
  readonly views: ReadonlyArray<ReturnType<typeof view>>;
  readonly result: ReadCheckResult;
  readonly waits?: Record<string, ViewWait<never>>;
}) => {
  const calls = {
    head: 0,
    checks: [] as Array<{ views: string[]; marker: ProgressCursor.ProgressCursor | null }>,
    waits: [] as Array<{ view: string; cursor: ProgressCursor.ProgressCursor; ms: number }>,
    handled: 0
  };
  const wait: ViewWait<never> = (subscription, cursor, opts) => {
    calls.waits.push({ view: subscription.viewName, cursor, ms: Duration.toMillis(Duration.fromInputUnsafe(opts.timeout!)) });
    return (options.waits?.[subscription.viewName] ?? (() => Effect.void))(subscription, cursor, opts);
  };
  const read = makeConsistentRead<never>({
    config: options.config ?? defaultReadConsistency,
    deps: {
      head: Effect.sync(() => (calls.head++, head)),
      wait,
      check: (subscriptions, marker) => Effect.sync(() => (calls.checks.push({ views: subscriptions.map((s) => s.viewName), marker }), options.result))
    }
  });
  const endpoint = read(
    { reads: options.views, parse: () => Effect.succeed(null) },
    () => Effect.sync(() => (calls.handled++, { ok: true }))
  );
  const run = (query: Request["query"] = {}) => Effect.runPromise(endpoint({ query }));
  const fail = (query: Request["query"] = {}) => Effect.runPromise(Effect.flip(endpoint({ query })));
  return { calls, run, fail, endpoint };
};

const timedOut = (reached: bigint): ViewWait<never> => (subscription, cursor) =>
  Effect.fail(new WaitTimeout({ message: "late", viewName: subscription.viewName, position: cursor.position, reached }));
const viewFailed: ViewWait<never> = (subscription) => Effect.fail(new ViewFailed({ message: "failed", viewName: subscription.viewName }));

describe("a read whose first look is one statement", () => {
  it("every view already at the head: one check, no head, no wait, and the handler runs", async () => {
    const h = harness({ views: [view("balance")], result: { head, views: [atHead] } });
    const response = await h.run();
    expect(response.headers).toEqual({});
    expect(h.calls.checks).toEqual([{ views: ["balance"], marker: null }]);
    expect(h.calls.head).toBe(0);
    expect(h.calls.waits).toEqual([]);
    expect(h.calls.handled).toBe(1);
  });

  it("a view behind with nothing of its own pending needs no wait either (the write is an event it does not handle)", async () => {
    const h = harness({ views: [view("balance")], result: { head, views: [{ ...behind, pending: false }] } });
    await h.run();
    expect(h.calls.waits).toEqual([]);
    expect(h.calls.handled).toBe(1);
  });

  it("with a marker: the check gets the marker, and a view at or past it needs no wait", async () => {
    const marker = ProgressCursor.of("7000", 90000n);
    const h = harness({ views: [view("balance")], result: { head, views: [ahead(ProgressCursor.of("7000", 90000n))] } });
    await h.run({ consistentWith: "7000:90000" });
    expect(h.calls.checks).toEqual([{ views: ["balance"], marker }]);
    expect(h.calls.waits).toEqual([]);
  });

  it("only the views that are behind wait, for the write they were asked about, at the time the request allows", async () => {
    const h = harness({ views: [view("a"), view("b"), view("c")], result: { head, views: [atHead, behind, atHead] } });
    await h.run({ waitTimeout: "750" });
    expect(h.calls.waits).toEqual([{ view: "b", cursor: head, ms: 750 }]);
    expect(h.calls.handled).toBe(1);
  });

  it("a marker is the write the waiting views wait for", async () => {
    const marker = ProgressCursor.of("7000", 90000n);
    // behind the MARKER (an earlier transaction id: the cursor orders by it first), and pending
    const behindTheMarker = { cursor: ProgressCursor.of("6000", 10n), status: "ACTIVE" as string | null, pending: true };
    const h = harness({ views: [view("a"), view("b")], result: { head, views: [atHead, behindTheMarker] } });
    await h.run({ consistentWith: "7000:90000" });
    // (and a view at the head but past a marker below it needs no wait, as in the test above)
    expect(h.calls.waits).toEqual([{ view: "b", cursor: marker, ms: expect.any(Number) as unknown as number }]);
  });

  it("a marker beyond the end of the log is a 400, and nothing waits or runs", async () => {
    const h = harness({ views: [view("a")], result: { head, views: [atHead] } });
    const error = await h.fail({ consistentWith: "9999:99999999" });
    expect(error).toBeInstanceOf(CommandApiBadRequest);
    expect(h.calls.waits).toEqual([]);
    expect(h.calls.handled).toBe(0);
  });

  it("an endpoint that reads no views still checks the marker against the end of the log", async () => {
    const h = harness({ views: [], result: { head, views: [] } });
    await h.run();
    expect(h.calls.checks).toEqual([{ views: [], marker: null }]);
    expect(h.calls.handled).toBe(1);
    const beyond = harness({ views: [], result: { head, views: [] } });
    expect(await beyond.fail({ consistentWith: "9999:99999999" })).toBeInstanceOf(CommandApiBadRequest);
    expect(beyond.calls.handled).toBe(0);
  });

  it("the same view read twice is checked and waited for by position, not by name", async () => {
    const h = harness({ views: [view("a"), view("a")], result: { head, views: [atHead, behind] } });
    await h.run();
    expect(h.calls.waits.map((w) => w.view)).toEqual(["a"]);
  });

  it("a FAILED view that is behind with something pending is reported at once as view_failed, without a wait, and lagging views are listed with it in the order given", async () => {
    const h = harness({
      views: [view("a"), view("b"), view("c")],
      result: { head, views: [behind, failedAndPending, atHead] },
      waits: { a: timedOut(10n) }
    });
    const error = await h.fail();
    expect(error).toBeInstanceOf(ViewsUnavailable);
    const problem = error as ViewsUnavailable;
    expect(problem.reason).toBe("view_failed");
    expect(problem.views).toEqual([
      { name: "a", reason: "lagging", reachedPosition: "10" },
      { name: "b", reason: "view_failed", reachedPosition: null }
    ]);
    expect(h.calls.waits.map((w) => w.view)).toEqual(["a"]);
    expect(h.calls.handled).toBe(0);
  });

  it("strict and out of time: the 503 names the lagging view; bounded serves the data marked stale", async () => {
    const strict = harness({ views: [view("a")], result: { head, views: [behind] }, waits: { a: timedOut(10n) } });
    expect(await strict.fail()).toBeInstanceOf(ViewsUnavailable);
    const bounded = harness({ config: { ...defaultReadConsistency, clientMayRelax: true }, views: [view("a")], result: { head, views: [behind] }, waits: { a: timedOut(10n) } });
    const response = await bounded.run({ consistency: "bounded" });
    expect(response.headers).toEqual({ "crablet-consistency": "stale" });
    expect(bounded.calls.handled).toBe(1);
  });

  it("a view that fails while waiting is a view_failed outcome", async () => {
    const h = harness({ views: [view("a")], result: { head, views: [behind] }, waits: { a: viewFailed } });
    expect(((await h.fail()) as ViewsUnavailable).reason).toBe("view_failed");
  });

  it("no check for a read that does not wait: eventual, or no marker where the server says none", async () => {
    const h = harness({ config: { ...defaultReadConsistency, whenNoMarker: "none" }, views: [view("a")], result: { head, views: [atHead] } });
    await h.run();
    expect(h.calls.checks).toEqual([]);
    expect(h.calls.handled).toBe(1);
  });

  it("a database error in the check is a defect, not a verdict about the views", async () => {
    const read = makeConsistentRead<never>({
      deps: { head: Effect.succeed(head), wait: () => Effect.void, check: () => Effect.fail({ _tag: "SqlError" } as never) }
    });
    const exit = await Effect.runPromiseExit(read({ reads: [view("a")], parse: () => Effect.succeed(null) }, () => Effect.succeed({ ok: true }))({ query: {} }));
    expect(Exit.isFailure(exit) && Cause.hasDies(exit.cause)).toBe(true);
  });
});
