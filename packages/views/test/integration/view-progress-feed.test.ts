// Runs under Node (Testcontainers) - see NOTES.md. `viewProgressFeed` on the view progress hub (ADR-0016): it opens with where each named view is now,
// sends the pings of the named views and no others, and when the hub reconnects (a ping may have been missed) it says where the views are again. It
// holds no database connection of its own: it is a subscription to the hub.
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { Effect, Fiber, Layer, ManagedRuntime, Queue, Redacted, Stream } from "effect";
import { SqlClient } from "effect/sql";
import { PgClient } from "@effect/sql-pg";
import { startTestDb, type TestDb } from "@crablet/test-support";
import { ViewProgressHub, makeViewProgressHub, type ListenSource } from "../../src/ViewProgressHub.ts";
import { viewProgressFeed } from "../../src/ViewProgressFeed.ts";
import type { ViewProgressPing } from "../../src/ViewProgress.ts";

let db: TestDb;
let runtime: ManagedRuntime.ManagedRuntime<SqlClient.SqlClient | PgClient.PgClient, never>;

before(async () => {
  db = await startTestDb();
  const pgLayer = PgClient.layer({
    host: db.connInfo.host,
    port: db.connInfo.port,
    database: db.connInfo.database,
    username: db.connInfo.username,
    password: Redacted.make(db.connInfo.password)
  });
  runtime = ManagedRuntime.make(pgLayer as unknown as Layer.Layer<SqlClient.SqlClient | PgClient.PgClient, never>);
}, { timeout: 60_000 });
after(async () => {
  await runtime.dispose();
  await db.stop();
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const sqlError = (message: string) => ({ _tag: "SqlError", message }) as never;
const until = async (check: () => boolean, ms = 5000) => {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > ms) throw new Error("condition not reached in time");
    await sleep(10);
  }
};

const fakeSource = (failFirst = 0) => {
  const state = { connects: 0, failuresLeft: failFirst, current: null as Queue.Queue<{ readonly payload: string }, never> | null };
  const source: ListenSource = Effect.gen(function* () {
    if (state.failuresLeft > 0) {
      state.failuresLeft--;
      return yield* Effect.fail(sqlError("connection refused"));
    }
    state.connects++;
    const queue = yield* Queue.unbounded<{ readonly payload: string }, never>();
    state.current = queue;
    yield* Effect.addFinalizer(() => Queue.shutdown(queue));
    return queue as never;
  });
  return {
    state,
    source,
    ping: (id: string, n: number) => Queue.offerUnsafe(state.current!, { payload: JSON.stringify({ id, transactionId: String(n), position: String(n) }) }),
    drop: () => Effect.runPromise(Queue.fail(state.current as unknown as Queue.Queue<{ readonly payload: string }, unknown>, sqlError("connection lost")))
  };
};

// Runs a feed for `names` over a hub on `fake`; `frames` fills as it emits. `body` runs while it is open.
const withFeed = async (
  fake: ReturnType<typeof fakeSource>,
  names: ReadonlyArray<string>,
  body: (frames: Array<ViewProgressPing>, hub: { count: () => Promise<number> }) => Promise<void>
) => {
  const frames: Array<ViewProgressPing> = [];
  await runtime.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const hub = yield* makeViewProgressHub({ source: fake.source, retryBase: "5 millis", retryMax: "20 millis" });
        const fiber = yield* Effect.forkChild(
          viewProgressFeed(new Set(names)).pipe(
            Stream.runForEach((ping) => Effect.sync(() => void frames.push(ping))),
            Effect.provideService(ViewProgressHub, hub)
          )
        );
        yield* Effect.promise(() => body(frames, { count: () => Effect.runPromise(hub.subscriberCount) }));
        yield* Fiber.interrupt(fiber);
        assert.strictEqual(yield* hub.subscriberCount, 0, "the feed's subscription ended with the feed");
      })
    ) as Effect.Effect<void, never, SqlClient.SqlClient>
  );
};

const setProgress = (view: string, n: number) =>
  runtime.runPromise(
    Effect.flatMap(SqlClient.SqlClient, (sql) =>
      Effect.asVoid(
        sql.unsafe(
          "INSERT INTO crablet_view_progress (view_name, last_position, last_transaction_id) VALUES ($1, $2, $3::xid8) ON CONFLICT (view_name) DO UPDATE SET last_position = $2, last_transaction_id = $3::xid8",
          [view, String(n), String(n)]
        )
      )
    )
  );

describe("viewProgressFeed over the hub", () => {
  it("opens with where each named view is now, and nothing for a view with no progress", { timeout: 30_000 }, async () => {
    const id = crypto.randomUUID().slice(0, 8);
    await setProgress(`feed-a-${id}`, 41);
    await setProgress(`feed-b-${id}`, 17);
    const fake = fakeSource();
    await withFeed(fake, [`feed-a-${id}`, `feed-b-${id}`, `feed-never-${id}`], async (frames) => {
      await until(() => frames.length >= 2);
      await sleep(100);
      const opening = frames.filter((f) => !f.id.startsWith("feed-never"));
      assert.deepStrictEqual(opening.map((f) => [f.id, f.position]).sort(), [[`feed-a-${id}`, "41"], [`feed-b-${id}`, "17"]]);
      assert.ok(!frames.some((f) => f.id === `feed-never-${id}`));
    });
  });

  it("then sends the pings of the named views, and none of the others", { timeout: 30_000 }, async () => {
    const id = crypto.randomUUID().slice(0, 8);
    await setProgress(`feed-mine-${id}`, 1);
    const fake = fakeSource();
    await withFeed(fake, [`feed-mine-${id}`], async (frames) => {
      await until(() => frames.length >= 1 && fake.state.connects === 1);
      await sleep(50);
      const before = frames.length;
      fake.ping(`feed-other-${id}`, 5);
      fake.ping(`feed-mine-${id}`, 6);
      await until(() => frames.length > before);
      await sleep(100);
      const added = frames.slice(before);
      assert.ok(added.every((f) => f.id === `feed-mine-${id}`), "only the named view");
      assert.strictEqual(added[added.length - 1]!.position, "6");
    });
  });

  it("when the hub reconnects it says where the views are NOW (a ping may have been missed)", { timeout: 30_000 }, async () => {
    const id = crypto.randomUUID().slice(0, 8);
    await setProgress(`feed-resync-${id}`, 10);
    const fake = fakeSource();
    await withFeed(fake, [`feed-resync-${id}`], async (frames) => {
      await until(() => fake.state.connects === 1 && frames.length >= 1);
      await sleep(100);
      const before = frames.length;
      await setProgress(`feed-resync-${id}`, 25); // the view moved while the connection was down: no ping reached us
      await fake.drop();
      await until(() => frames.length > before);
      assert.strictEqual(frames[frames.length - 1]!.position, "25", "read from the table, not from a ping");
    });
  });

  it("a feed opened before the hub has connected still says where the views are, and again once it connects", { timeout: 30_000 }, async () => {
    const id = crypto.randomUUID().slice(0, 8);
    await setProgress(`feed-late-${id}`, 3);
    const fake = fakeSource(3); // LISTEN fails three times before it works
    await withFeed(fake, [`feed-late-${id}`], async (frames) => {
      await until(() => frames.length >= 1);
      assert.strictEqual(frames[0]!.position, "3");
      await until(() => fake.state.connects === 1);
      await until(() => frames.length >= 2); // the first connect is announced too
      fake.ping(`feed-late-${id}`, 4);
      await until(() => frames[frames.length - 1]!.position === "4");
    });
  });
});
