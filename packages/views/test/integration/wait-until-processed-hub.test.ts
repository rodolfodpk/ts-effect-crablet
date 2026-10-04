// Runs under Node (Testcontainers) - see NOTES.md. `waitUntilProcessed` on the view progress hub (ADR-0016): with a hub in the context a wait is
// woken by the view's ping instead of polling, so it returns within milliseconds of the ping, asks the database far less while it waits, still
// ends on a missed ping (the safety interval) and re-checks at once after a reconnect. The view's progress is moved by SQL and the pings are sent
// through a hub over a source the test controls, so every timing here is the wait's own.
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { Effect, Fiber, Layer, ManagedRuntime, Queue, Redacted } from "effect";
import { SqlClient } from "effect/sql";
import { PgClient } from "@effect/sql-pg";
import { startTestDb, type TestDb } from "@crablet/test-support";
import { EventStore, EventStoreLive } from "@crablet/eventstore";
import * as AppendEvent from "@crablet/eventstore/AppendEvent";
import type { ProgressCursor } from "@crablet/event-poller/ProgressCursor";
import { viewSubscriptionOf, type ViewSubscription } from "../../src/ViewSubscription.ts";
import { ViewFailed, WaitTimeout, waitUntilProcessed, type WaitOptions } from "../../src/WaitUntilProcessed.ts";
import { ViewProgressHub, makeViewProgressHub, type ListenSource, type ViewProgressHubService } from "../../src/ViewProgressHub.ts";

let db: TestDb;
let runtime: ManagedRuntime.ManagedRuntime<EventStore | SqlClient.SqlClient | PgClient.PgClient, never>;

before(async () => {
  db = await startTestDb();
  const pgLayer = PgClient.layer({
    host: db.connInfo.host,
    port: db.connInfo.port,
    database: db.connInfo.database,
    username: db.connInfo.username,
    password: Redacted.make(db.connInfo.password)
  });
  runtime = ManagedRuntime.make(
    Layer.provideMerge(EventStoreLive, pgLayer) as unknown as Layer.Layer<EventStore | SqlClient.SqlClient | PgClient.PgClient, never>
  );
}, { timeout: 60_000 });
after(async () => {
  await runtime.dispose();
  await db.stop();
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const sqlError = (message: string) => ({ _tag: "SqlError", message }) as never;

// A notification source the test controls (one "connection" per listen), as in the hub's own tests.
const fakeSource = () => {
  const state = { connects: 0, current: null as Queue.Queue<{ readonly payload: string }, never> | null };
  const source: ListenSource = Effect.gen(function* () {
    state.connects++;
    const queue = yield* Queue.unbounded<{ readonly payload: string }, never>();
    state.current = queue;
    yield* Effect.addFinalizer(() => Queue.shutdown(queue));
    return queue as never;
  });
  return {
    state,
    source,
    ping: (viewName: string, cursor: ProgressCursor) =>
      Queue.offerUnsafe(state.current!, { payload: JSON.stringify({ id: viewName, transactionId: cursor.transactionId, position: String(cursor.position) }) }),
    drop: () => Effect.runPromise(Queue.fail(state.current as unknown as Queue.Queue<{ readonly payload: string }, unknown>, sqlError("connection lost")))
  };
};

interface Scenario {
  readonly view: ViewSubscription;
  readonly write: ProgressCursor;
  readonly queries: { n: number };
  readonly hub: ViewProgressHubService;
  readonly fake: ReturnType<typeof fakeSource>;
  readonly advance: (to?: ProgressCursor) => Promise<void>;
  readonly setStatus: (status: string) => Promise<void>;
  readonly wait: (options?: WaitOptions) => Promise<void>;
  readonly waitExit: (options?: WaitOptions) => Promise<unknown>;
}

// A view at the start of the log and a write it has not reached: one event of the view's type, appended now. Every query `waitUntilProcessed`
// makes through `wait` is counted.
const scenario = async (body: (s: Scenario) => Promise<void>, options: { readonly withHub?: boolean } = {}): Promise<void> => {
  const id = crypto.randomUUID().slice(0, 8);
  const viewName = `hub-wait-${id}`;
  const type = `HubWait-${id}`;
  const fake = fakeSource();
  await runtime.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql.unsafe("INSERT INTO crablet_view_progress (view_name) VALUES ($1)", [viewName]);
        const { transactionId, lastPosition } = yield* Effect.flatMap(EventStore, (es) => es.append([AppendEvent.of(type, "row", id, {})]));
        const write: ProgressCursor = { transactionId, position: lastPosition };
        const view = viewSubscriptionOf(viewName, { eventTypes: new Set([type]) });
        const hub = yield* makeViewProgressHub({ source: fake.source, retryBase: "5 millis", retryMax: "20 millis" });
        while (!(yield* hub.connected)) yield* Effect.sleep("5 millis");

        const queries = { n: 0 };
        const counting = new Proxy(sql, {
          get(target, property) {
            const value = Reflect.get(target, property, target);
            return property === "unsafe" ? (...args: Array<unknown>) => (queries.n++, (value as (...a: Array<unknown>) => unknown).apply(target, args)) : value;
          }
        });
        const waitEffect = (opts?: WaitOptions) => {
          const base = waitUntilProcessed(view, write, opts).pipe(Effect.provideService(SqlClient.SqlClient, counting));
          return options.withHub === false ? base : base.pipe(Effect.provideService(ViewProgressHub, hub));
        };
        const scenarioValue: Scenario = {
          view,
          write,
          queries,
          hub,
          fake,
          advance: (to = write) =>
            Effect.runPromise(
              Effect.asVoid(sql.unsafe("UPDATE crablet_view_progress SET last_position = $2, last_transaction_id = $3::xid8 WHERE view_name = $1", [viewName, to.position.toString(), to.transactionId]))
            ),
          setStatus: (status) => Effect.runPromise(Effect.asVoid(sql.unsafe("UPDATE crablet_view_progress SET status = $2 WHERE view_name = $1", [viewName, status]))),
          wait: (opts) => Effect.runPromise(waitEffect(opts) as Effect.Effect<void>),
          waitExit: (opts) => Effect.runPromise(Effect.flip(waitEffect(opts)) as Effect.Effect<unknown>)
        };
        yield* Effect.promise(() => body(scenarioValue));
      })
    ) as Effect.Effect<void, never, EventStore | SqlClient.SqlClient>
  );
};

describe("waitUntilProcessed with a hub", () => {
  it("returns within milliseconds of the ping, not at the next poll", { timeout: 30_000 }, async () => {
    await scenario(async (s) => {
      const started = Date.now();
      const waiting = s.wait({ interval: "2 seconds", safetyInterval: "10 seconds", timeout: "20 seconds" });
      await sleep(150);
      await s.advance();
      s.fake.ping(s.view.viewName, s.write);
      await waiting;
      const took = Date.now() - started;
      assert.ok(took >= 140, `it was still waiting before the ping (${took} ms)`);
      assert.ok(took < 400, `it returned right after the ping, long before the 2 s poll or the 10 s safety interval (${took} ms)`);
    });
  });

  it("asks the database far less while it waits than a poll does", { timeout: 30_000 }, async () => {
    let withHubQueries = 0;
    await scenario(async (s) => {
      const outcome = await s.waitExit({ timeout: "1500 millis", safetyInterval: "500 millis", interval: "25 millis" });
      assert.ok(outcome instanceof WaitTimeout);
      withHubQueries = s.queries.n;
    });
    let polledQueries = 0;
    await scenario(
      async (s) => {
        const outcome = await s.waitExit({ timeout: "1500 millis", interval: "25 millis" });
        assert.ok(outcome instanceof WaitTimeout);
        polledQueries = s.queries.n;
      },
      { withHub: false }
    );
    assert.ok(withHubQueries <= 12, `with a hub: ${withHubQueries} queries in 1.5 s`);
    assert.ok(polledQueries >= 60, `polling, for contrast: ${polledQueries} queries in 1.5 s`);
  });

  it("pings for other views do not make it look again", { timeout: 30_000 }, async () => {
    await scenario(async (s) => {
      const waiting = s.waitExit({ timeout: "1200 millis", safetyInterval: "10 seconds" });
      for (let n = 0; n < 50; n++) {
        s.fake.ping(`some-other-view-${n % 5}`, { transactionId: "1", position: BigInt(n + 1) });
        await sleep(10);
      }
      assert.ok((await waiting) instanceof WaitTimeout);
      assert.ok(s.queries.n <= 10, `${s.queries.n} queries: the first check, the deadline, and what the timeout needs`);
    });
  });

  it("still ends on a missed ping: the safety interval looks again", { timeout: 30_000 }, async () => {
    await scenario(async (s) => {
      const started = Date.now();
      const waiting = s.wait({ safetyInterval: "200 millis", timeout: "10 seconds" });
      await sleep(50);
      await s.advance(); // the view caught up, and the ping was lost
      await waiting;
      const took = Date.now() - started;
      assert.ok(took >= 190 && took < 700, `found it at the next safety check (${took} ms)`);
    });
  });

  it("after the hub reconnects it looks again at once (a ping may have been missed)", { timeout: 30_000 }, async () => {
    await scenario(async (s) => {
      const waiting = s.wait({ safetyInterval: "30 seconds", timeout: "60 seconds" });
      await sleep(100);
      await s.advance(); // moved, and no ping
      const started = Date.now();
      await s.fake.drop(); // the hub's connection is lost and re-established: every subscriber is told to re-read
      await waiting;
      assert.ok(Date.now() - started < 1500, "woken by the reconnect, not by the 30 s safety interval");
      assert.ok(s.fake.state.connects >= 2);
    });
  });

  it("a view that is FAILED is reported on the next look, not at the timeout", { timeout: 30_000 }, async () => {
    await scenario(async (s) => {
      const started = Date.now();
      const waiting = s.waitExit({ safetyInterval: "10 seconds", timeout: "20 seconds" });
      await sleep(100);
      await s.setStatus("FAILED");
      s.fake.ping(s.view.viewName, { transactionId: "0", position: 0n });
      assert.ok((await waiting) instanceof ViewFailed);
      assert.ok(Date.now() - started < 1500);
    });
  });

  it("the timeout still holds, and says how far the view got", { timeout: 30_000 }, async () => {
    await scenario(async (s) => {
      const started = Date.now();
      const outcome = await s.waitExit({ timeout: "400 millis", safetyInterval: "10 seconds" });
      assert.ok(outcome instanceof WaitTimeout);
      assert.strictEqual(outcome.reached, 0n);
      const took = Date.now() - started;
      assert.ok(took >= 390 && took < 1500, `ended at the deadline, not at the safety interval (${took} ms)`);
    });
  });

  it("with nothing to wait for, returns without waiting", { timeout: 30_000 }, async () => {
    await scenario(async (s) => {
      await s.advance();
      const started = Date.now();
      await s.wait({ safetyInterval: "10 seconds" });
      assert.ok(Date.now() - started < 300);
    });
  });
});

describe("waitUntilProcessed without a hub, or with one that is not connected", () => {
  it("polls as before", { timeout: 30_000 }, async () => {
    await scenario(
      async (s) => {
        const started = Date.now();
        const waiting = s.wait({ interval: "25 millis", timeout: "10 seconds" });
        await sleep(100);
        await s.advance();
        await waiting;
        assert.ok(Date.now() - started < 400);
      },
      { withHub: false }
    );
  });

  it("a hub whose LISTEN is down counts as no hub: it polls at `interval`", { timeout: 30_000 }, async () => {
    const down = new Proxy({} as ViewProgressHubService, {
      get: (_t, property) =>
        property === "connected" ? Effect.succeed(false) : property === "subscribe" ? () => Effect.succeed({ next: Effect.never }) : Effect.succeed(0)
    });
    const id = crypto.randomUUID().slice(0, 8);
    await runtime.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* sql.unsafe("INSERT INTO crablet_view_progress (view_name) VALUES ($1)", [`down-${id}`]);
          const { transactionId, lastPosition } = yield* Effect.flatMap(EventStore, (es) => es.append([AppendEvent.of(`Down-${id}`, "row", id, {})]));
          const view = viewSubscriptionOf(`down-${id}`, { eventTypes: new Set([`Down-${id}`]) });
          const fiber = yield* Effect.forkChild(
            waitUntilProcessed(view, { transactionId, position: lastPosition }, { interval: "25 millis", safetyInterval: "30 seconds", timeout: "10 seconds" }).pipe(
              Effect.provideService(ViewProgressHub, down)
            )
          );
          yield* Effect.sleep("100 millis");
          yield* sql.unsafe("UPDATE crablet_view_progress SET last_position = $2, last_transaction_id = $3::xid8 WHERE view_name = $1", [`down-${id}`, lastPosition.toString(), transactionId]);
          yield* Effect.timeout(Fiber.join(fiber), "2 seconds"); // it found the move by polling
        })
      ) as Effect.Effect<void, unknown, EventStore | SqlClient.SqlClient>
    );
  });
});

