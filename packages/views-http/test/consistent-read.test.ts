import { describe, expect, it } from "bun:test";
import { Cause, Effect, Exit } from "effect";
import { CommandApiBadRequest } from "@crablet/commands-http/ProblemDetail";
import * as ProgressCursor from "@crablet/event-poller/ProgressCursor";
import type { Settlement, SettleViews, UncaughtView } from "@crablet/views/SettleViews";
import { viewSubscriptionOf } from "@crablet/views/ViewSubscription";
import { makeConsistentRead, type ReadSpec } from "../src/ConsistentRead.ts";
import { defaultReadConsistency, type ConsistencyParams, type ReadConsistencyConfig } from "../src/ReadConsistency.ts";
import { ViewsUnavailable } from "../src/ReadProblems.ts";

// The wrapper over a fake `settleViews`: what it is asked (the views, the marker, the timeout) and what the wrapper makes of each settlement. Which views wait and what the
// outcome lists is `settleViews`'s, tested in @crablet/views.
const view = (name: string) => viewSubscriptionOf(name, { eventTypes: new Set(["E"]) });
const head = ProgressCursor.of("7421", 98213n);

const caughtUp: Settlement = { _tag: "Settled", outcome: { _tag: "CaughtUp" } };
const notCaughtUp = (...views: ReadonlyArray<UncaughtView>): Settlement => ({
  _tag: "Settled",
  outcome: { _tag: "NotCaughtUp", reason: views.some((v) => v.reason === "view_failed") ? "view_failed" : "lagging", views }
});
const lagging = (name: string, reached: string): UncaughtView => ({ name, reason: "lagging", reachedPosition: reached });
const failed = (name: string): UncaughtView => ({ name, reason: "view_failed", reachedPosition: null });

interface Request {
  readonly query: ConsistencyParams & { readonly limit?: string; readonly withSummary?: string };
}
interface Parsed {
  readonly limit: number;
  readonly withSummary: boolean;
}

// An endpoint over a fake settle: the settle and the handler record what they were asked.
const harness = (options: {
  readonly config?: ReadConsistencyConfig;
  readonly settlement?: Settlement;
  readonly retryAfterSeconds?: number;
  readonly reads?: ReadSpec<Request, Parsed, never, never>["reads"];
} = {}) => {
  const calls = { settles: [] as Array<{ views: string[]; marker: ProgressCursor.ProgressCursor | null; timeoutMs: number }>, handled: [] as Array<Parsed> };
  const settle: SettleViews<never> = (subscriptions, marker, timeoutMs) =>
    Effect.sync(() => (calls.settles.push({ views: subscriptions.map((s) => s.viewName), marker, timeoutMs }), options.settlement ?? caughtUp));
  const read = makeConsistentRead<never>({
    config: options.config ?? defaultReadConsistency,
    ...(options.retryAfterSeconds === undefined ? {} : { retryAfterSeconds: options.retryAfterSeconds }),
    settle
  });
  const endpoint = read(
    {
      reads: options.reads ?? ((parsed: Parsed) => (parsed.withSummary ? [view("balance"), view("summary")] : [view("balance")])),
      parse: (req: Request) =>
        req.query.limit === undefined || /^[1-9][0-9]*$/.test(req.query.limit)
          ? Effect.succeed<Parsed>({ limit: Number(req.query.limit ?? 20), withSummary: req.query.withSummary === "yes" })
          : Effect.fail(CommandApiBadRequest.of("limit must be a whole number from 1 to 100"))
    },
    (parsed: Parsed) => Effect.sync(() => (calls.handled.push(parsed), { items: [`limit ${parsed.limit}`] }))
  );
  const run = (query: Request["query"] = {}) => Effect.runPromise(endpoint({ query }));
  const fail = (query: Request["query"] = {}) => Effect.runPromise(Effect.flip(endpoint({ query })));
  return { calls, run, fail, endpoint };
};

describe("a read with no parameters (the default: strict, and a read of the head of the log)", () => {
  it("settles every view it reads against the head of the log (no marker), with the default timeout, then runs the handler", async () => {
    const h = harness();
    const response = await h.run();
    expect(response.body).toEqual({ items: ["limit 20"] });
    expect(response.headers).toEqual({});
    expect(h.calls.settles).toEqual([{ views: ["balance"], marker: null, timeoutMs: 5000 }]);
    expect(h.calls.handled).toHaveLength(1);
  });
});

describe("a read with a marker", () => {
  it("settles the views against THAT write", async () => {
    const h = harness();
    await h.run({ consistentWith: "7000:90000" });
    expect(h.calls.settles).toEqual([{ views: ["balance"], marker: ProgressCursor.of("7000", 90000n), timeoutMs: 5000 }]);
    expect(h.calls.handled).toHaveLength(1);
  });

  it("is a 400, and the handler does not run, when the marker is beyond the end of the log", async () => {
    const h = harness({ settlement: { _tag: "Beyond", head } });
    const error = await h.fail({ consistentWith: "7421:98214" });
    expect(error).toBeInstanceOf(CommandApiBadRequest);
    expect((error as CommandApiBadRequest).detail).toContain("beyond");
    expect(h.calls.handled).toEqual([]);
  });

  it("is a 400 for a malformed marker, before any database work", async () => {
    const h = harness();
    const error = await h.fail({ consistentWith: "nonsense" });
    expect((error as CommandApiBadRequest).detail).toContain("consistentWith");
    expect(h.calls.settles).toEqual([]);
  });

  it("consistentWith=latest is a read of the head of the log", async () => {
    const h = harness({ config: { ...defaultReadConsistency, whenNoMarker: "none" } });
    await h.run({ consistentWith: "latest" });
    expect(h.calls.settles[0]!.marker).toBeNull();
  });
});

describe("validation comes before any waiting", () => {
  it("the endpoint's own bad parameter is a 400 and the database is not touched", async () => {
    const h = harness();
    const error = await h.fail({ limit: "0" });
    expect((error as CommandApiBadRequest).detail).toContain("limit");
    expect(h.calls.settles).toEqual([]);
    expect(h.calls.handled).toEqual([]);
  });

  it("a bad consistency parameter is a 400 and the database is not touched", async () => {
    const h = harness();
    for (const query of [{ consistency: "weak" }, { waitTimeout: "abc" }, { consistency: "eventual" } /* not allowed by default */]) {
      const error = await h.fail(query);
      expect(error).toBeInstanceOf(CommandApiBadRequest);
    }
    expect(h.calls.settles).toEqual([]);
  });
});

describe("a read that does not wait", () => {
  it("whenNoMarker none and no marker: nothing is settled, the handler runs", async () => {
    const h = harness({ config: { ...defaultReadConsistency, whenNoMarker: "none" } });
    const response = await h.run();
    expect(response.headers).toEqual({});
    expect(h.calls.settles).toEqual([]);
    expect(h.calls.handled).toHaveLength(1);
  });

  it("consistency=eventual, where the server allows it: nothing is settled, even with a marker", async () => {
    const h = harness({ config: { ...defaultReadConsistency, clientMayRelax: true } });
    await h.run({ consistency: "eventual", consistentWith: "7000:90000" });
    expect(h.calls.settles).toEqual([]);
    expect(h.calls.handled).toHaveLength(1);
  });

  it("an endpoint that reads no views still has its marker checked against the end of the log, then just runs", async () => {
    const h = harness({ reads: [] });
    await h.run();
    expect(h.calls.settles).toEqual([{ views: [], marker: null, timeoutMs: 5000 }]);
    expect(h.calls.handled).toHaveLength(1);
    const beyond = harness({ reads: [], settlement: { _tag: "Beyond", head } });
    expect(await beyond.fail({ consistentWith: "9999:99999999" })).toBeInstanceOf(CommandApiBadRequest);
    expect(beyond.calls.handled).toEqual([]);
  });
});

describe("the views it reads", () => {
  it("can depend on the endpoint's own parsed parameters", async () => {
    const h = harness();
    await h.run({ withSummary: "yes" });
    expect(h.calls.settles[0]!.views).toEqual(["balance", "summary"]);
  });

  it("a request's waitTimeout is the time the views are given", async () => {
    const h = harness();
    await h.run({ withSummary: "yes", waitTimeout: "1200" });
    expect(h.calls.settles[0]!.timeoutMs).toBe(1200);
  });
});

describe("strict (the default) when a view has not caught up", () => {
  it("fails with a 503 that names each lagging view and how far it got, and does not run the handler", async () => {
    const h = harness({ settlement: notCaughtUp(lagging("summary", "97000")) });
    const error = await h.fail({ withSummary: "yes" });
    expect(error).toBeInstanceOf(ViewsUnavailable);
    const problem = error as ViewsUnavailable;
    expect(problem.status).toBe(503);
    expect(problem.reason).toBe("lagging");
    expect(problem.views).toEqual([{ name: "summary", reason: "lagging", reachedPosition: "97000" }]);
    expect(problem.retryAfterSeconds).toBe(1);
    expect(h.calls.handled).toEqual([]);
  });

  it("asks the client to retry after the configured number of seconds", async () => {
    const error = (await harness({ settlement: notCaughtUp(lagging("balance", "1")), retryAfterSeconds: 3 }).fail()) as ViewsUnavailable;
    expect(error.retryAfterSeconds).toBe(3);
  });

  it("a FAILED view is view_failed, with no Retry-After (retrying will not help), and lagging views are listed with it", async () => {
    const error = (await harness({ settlement: notCaughtUp(lagging("a", "10"), failed("b")) }).fail()) as ViewsUnavailable;
    expect(error.reason).toBe("view_failed");
    expect(error.views).toEqual([
      { name: "a", reason: "lagging", reachedPosition: "10" },
      { name: "b", reason: "view_failed", reachedPosition: null }
    ]);
    expect(error.retryAfterSeconds).toBeUndefined();
  });
});

describe("bounded when a view has not caught up", () => {
  const bounded: ReadConsistencyConfig = { ...defaultReadConsistency, mode: "bounded" };

  it("runs the handler anyway and marks the response stale", async () => {
    const h = harness({ config: bounded, settlement: notCaughtUp(lagging("balance", "1")) });
    const response = await h.run();
    expect(response.body).toEqual({ items: ["limit 20"] });
    expect(response.headers).toEqual({ "crablet-consistency": "stale" });
    expect(h.calls.handled).toHaveLength(1);
  });

  it("a FAILED view is served stale too (bounded is best effort)", async () => {
    const response = await harness({ config: bounded, settlement: notCaughtUp(failed("balance")) }).run();
    expect(response.headers).toEqual({ "crablet-consistency": "stale" });
  });

  it("is not marked stale when every view caught up", async () => {
    expect((await harness({ config: bounded }).run()).headers).toEqual({});
  });

  it("a client may ask for strict on an endpoint whose default is bounded", async () => {
    const h = harness({ config: bounded, settlement: notCaughtUp(lagging("balance", "1")) });
    expect(await h.fail({ consistency: "strict" })).toBeInstanceOf(ViewsUnavailable);
  });
});

describe("a database failure while settling is a defect, not a verdict about the views", () => {
  it("is not reported as a 503", async () => {
    const read = makeConsistentRead<never>({ settle: () => Effect.fail({ _tag: "SqlError", message: "connection lost" } as never) });
    const exit = await Effect.runPromiseExit(read({ reads: [view("a")], parse: () => Effect.succeed({}) }, () => Effect.succeed("ok"))({ query: {} }));
    expect(Exit.isFailure(exit) && Cause.hasDies(exit.cause)).toBe(true);
    expect(JSON.stringify(exit)).not.toContain("ViewsUnavailable");
  });
});
