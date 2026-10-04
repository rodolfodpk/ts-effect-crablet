import { describe, expect, it } from "bun:test";
import { Duration, Effect } from "effect";
import { CommandApiBadRequest } from "@crablet/commands-http/ProblemDetail";
import * as ProgressCursor from "@crablet/event-poller/ProgressCursor";
import { viewSubscriptionOf } from "@crablet/views/ViewSubscription";
import { ViewFailed, WaitTimeout } from "@crablet/views/WaitUntilProcessed";
import { makeConsistentRead, type ReadSpec } from "../src/ConsistentRead.ts";
import { defaultReadConsistency, type ConsistencyParams, type ReadConsistencyConfig } from "../src/ReadConsistency.ts";
import { ViewsUnavailable } from "../src/ReadProblems.ts";
import type { ViewWait } from "../src/WaitForViews.ts";

const view = (name: string) => viewSubscriptionOf(name, { eventTypes: new Set(["E"]) });
const head = ProgressCursor.of("7421", 98213n);

const timedOut = (reached: bigint): ViewWait<never> => (subscription, cursor) =>
  Effect.fail(new WaitTimeout({ message: "late", viewName: subscription.viewName, position: cursor.position, reached }));
const failed: ViewWait<never> = (subscription) => Effect.fail(new ViewFailed({ message: "failed", viewName: subscription.viewName }));

interface Request {
  readonly query: ConsistencyParams & { readonly limit?: string; readonly withSummary?: string };
}
interface Parsed {
  readonly limit: number;
  readonly withSummary: boolean;
}

// An endpoint over fakes: the head of the log, each view's wait, and the handler record what they were asked.
const harness = (options: {
  readonly config?: ReadConsistencyConfig;
  readonly waits?: Record<string, ViewWait<never>>;
  readonly headCursor?: ProgressCursor.ProgressCursor;
  readonly retryAfterSeconds?: number;
  readonly reads?: ReadSpec<Request, Parsed, never, never>["reads"];
} = {}) => {
  const calls = { head: 0, waits: [] as Array<{ view: string; cursor: ProgressCursor.ProgressCursor; ms: number }>, handled: [] as Array<Parsed> };
  const wait: ViewWait<never> = (subscription, cursor, opts) => {
    calls.waits.push({ view: subscription.viewName, cursor, ms: Duration.toMillis(Duration.fromInputUnsafe(opts.timeout!)) });
    return (options.waits?.[subscription.viewName] ?? (() => Effect.void))(subscription, cursor, opts);
  };
  const read = makeConsistentRead<never>({
    config: options.config ?? defaultReadConsistency,
    ...(options.retryAfterSeconds === undefined ? {} : { retryAfterSeconds: options.retryAfterSeconds }),
    deps: { head: Effect.sync(() => (calls.head++, options.headCursor ?? head)), wait }
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
  it("reads the head of the log once, waits for every view it reads until that point, then runs the handler", async () => {
    const h = harness();
    const response = await h.run();
    expect(response.body).toEqual({ items: ["limit 20"] });
    expect(response.headers).toEqual({});
    expect(h.calls.head).toBe(1);
    expect(h.calls.waits).toEqual([{ view: "balance", cursor: head, ms: 5000 }]);
    expect(h.calls.handled).toHaveLength(1);
  });
});

describe("a read with a marker", () => {
  it("waits for THAT write, not for the head, after checking the marker is not beyond the end of the log", async () => {
    const h = harness();
    await h.run({ consistentWith: "7000:90000" });
    expect(h.calls.head).toBe(1);
    expect(h.calls.waits).toEqual([{ view: "balance", cursor: ProgressCursor.of("7000", 90000n), ms: 5000 }]);
    expect(h.calls.handled).toHaveLength(1);
  });

  it("a marker exactly at the head is allowed", async () => {
    const h = harness();
    await h.run({ consistentWith: "7421:98213" });
    expect(h.calls.handled).toHaveLength(1);
  });

  it("is a 400, and nothing else happens, when the marker is beyond the end of the log", async () => {
    const h = harness();
    const error = await h.fail({ consistentWith: "7421:98214" });
    expect(error).toBeInstanceOf(CommandApiBadRequest);
    expect((error as CommandApiBadRequest).detail).toContain("beyond");
    expect(h.calls.waits).toEqual([]);
    expect(h.calls.handled).toEqual([]);
  });

  it("is a 400 for a malformed marker, before any database work", async () => {
    const h = harness();
    const error = await h.fail({ consistentWith: "nonsense" });
    expect((error as CommandApiBadRequest).detail).toContain("consistentWith");
    expect(h.calls.head).toBe(0);
    expect(h.calls.waits).toEqual([]);
  });

  it("consistentWith=latest is a read of the head of the log", async () => {
    const h = harness({ config: { ...defaultReadConsistency, whenNoMarker: "none" } });
    await h.run({ consistentWith: "latest" });
    expect(h.calls.waits[0]!.cursor).toEqual(head);
  });
});

describe("validation comes before any waiting", () => {
  it("the endpoint's own bad parameter is a 400 and the database is not touched", async () => {
    const h = harness();
    const error = await h.fail({ limit: "0" });
    expect((error as CommandApiBadRequest).detail).toContain("limit");
    expect(h.calls.head).toBe(0);
    expect(h.calls.waits).toEqual([]);
    expect(h.calls.handled).toEqual([]);
  });

  it("a bad consistency parameter is a 400 and the database is not touched", async () => {
    const h = harness();
    for (const query of [{ consistency: "weak" }, { waitTimeout: "abc" }, { consistency: "eventual" } /* not allowed by default */]) {
      const error = await h.fail(query);
      expect(error).toBeInstanceOf(CommandApiBadRequest);
    }
    expect(h.calls.head).toBe(0);
    expect(h.calls.waits).toEqual([]);
  });
});

describe("a read that does not wait", () => {
  it("whenNoMarker none and no marker: no head, no wait, the handler runs", async () => {
    const h = harness({ config: { ...defaultReadConsistency, whenNoMarker: "none" } });
    const response = await h.run();
    expect(response.headers).toEqual({});
    expect(h.calls.head).toBe(0);
    expect(h.calls.waits).toEqual([]);
    expect(h.calls.handled).toHaveLength(1);
  });

  it("consistency=eventual, where the server allows it: no head, no wait, even with a marker", async () => {
    const h = harness({ config: { ...defaultReadConsistency, clientMayRelax: true } });
    await h.run({ consistency: "eventual", consistentWith: "7000:90000" });
    expect(h.calls.head).toBe(0);
    expect(h.calls.waits).toEqual([]);
    expect(h.calls.handled).toHaveLength(1);
  });

  it("an endpoint that reads no views just runs", async () => {
    const h = harness({ reads: [] });
    await h.run();
    expect(h.calls.waits).toEqual([]);
    expect(h.calls.handled).toHaveLength(1);
  });
});

describe("the views it reads", () => {
  it("can depend on the endpoint's own parsed parameters", async () => {
    const h = harness();
    await h.run({ withSummary: "yes" });
    expect(h.calls.waits.map((w) => w.view).sort()).toEqual(["balance", "summary"]);
  });

  it("a request's waitTimeout is the time given to every view", async () => {
    const h = harness();
    await h.run({ withSummary: "yes", waitTimeout: "1200" });
    expect(h.calls.waits.map((w) => w.ms)).toEqual([1200, 1200]);
  });
});

describe("strict (the default) when a view has not caught up", () => {
  it("fails with a 503 that names each lagging view and how far it got, and does not run the handler", async () => {
    const h = harness({ waits: { summary: timedOut(97000n) } });
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
    const error = (await harness({ waits: { balance: timedOut(1n) }, retryAfterSeconds: 3 }).fail()) as ViewsUnavailable;
    expect(error.retryAfterSeconds).toBe(3);
  });

  it("a FAILED view is reported at once as view_failed, with no Retry-After (retrying will not help)", async () => {
    const error = (await harness({ waits: { balance: failed } }).fail()) as ViewsUnavailable;
    expect(error.reason).toBe("view_failed");
    expect(error.views).toEqual([{ name: "balance", reason: "view_failed", reachedPosition: null }]);
    expect(error.retryAfterSeconds).toBeUndefined();
  });
});

describe("bounded when a view has not caught up", () => {
  const bounded: ReadConsistencyConfig = { ...defaultReadConsistency, mode: "bounded" };

  it("runs the handler anyway and marks the response stale", async () => {
    const h = harness({ config: bounded, waits: { balance: timedOut(1n) } });
    const response = await h.run();
    expect(response.body).toEqual({ items: ["limit 20"] });
    expect(response.headers).toEqual({ "crablet-consistency": "stale" });
    expect(h.calls.handled).toHaveLength(1);
  });

  it("a FAILED view is served stale too (bounded is best effort)", async () => {
    const response = await harness({ config: bounded, waits: { balance: failed } }).run();
    expect(response.headers).toEqual({ "crablet-consistency": "stale" });
  });

  it("is not marked stale when every view caught up", async () => {
    expect((await harness({ config: bounded }).run()).headers).toEqual({});
  });

  it("a client may ask for strict on an endpoint whose default is bounded", async () => {
    const h = harness({ config: bounded, waits: { balance: timedOut(1n) } });
    expect(await h.fail({ consistency: "strict" })).toBeInstanceOf(ViewsUnavailable);
  });
});

describe("a database failure while checking is a defect, not a verdict about the views", () => {
  it("is not reported as a 503", async () => {
    const read = makeConsistentRead<never>({ deps: { head: Effect.fail({ _tag: "SqlError", message: "connection lost" } as never), wait: () => Effect.void } });
    const endpoint = read({ reads: [view("a")], parse: () => Effect.succeed({}) }, () => Effect.succeed("ok"));
    const exit = await Effect.runPromiseExit(endpoint({ query: {} }));
    expect(JSON.stringify(exit)).toContain("Die");
    expect(JSON.stringify(exit)).not.toContain("ViewsUnavailable");
  });
});
