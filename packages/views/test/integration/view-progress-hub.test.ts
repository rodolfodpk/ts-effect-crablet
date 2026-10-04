// Runs under Node (Testcontainers) - see NOTES.md. The hub over a real `LISTEN crablet_view_progress`: pings from the database reach its
// subscribers, many subscribers share ONE database connection, and when that connection is killed the hub reconnects and tells every
// subscriber to re-read.
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { Client } from "pg";
import { Effect, Layer, ManagedRuntime, Redacted, Scope } from "effect";
import { PgClient } from "@effect/sql-pg";
import { startTestDb, type TestDb } from "@crablet/test-support";
import { ViewProgressHub, ViewProgressHubLive } from "../../src/ViewProgressHub.ts";
import { VIEW_PROGRESS_CHANNEL } from "../../src/ViewProgress.ts";

let db: TestDb;
let admin: Client;
let runtime: ManagedRuntime.ManagedRuntime<ViewProgressHub, never>;

before(async () => {
  db = await startTestDb();
  admin = new Client({ host: db.connInfo.host, port: db.connInfo.port, database: db.connInfo.database, user: db.connInfo.username, password: db.connInfo.password });
  await admin.connect();
  const pgLayer = PgClient.layer({
    host: db.connInfo.host,
    port: db.connInfo.port,
    database: db.connInfo.database,
    username: db.connInfo.username,
    password: Redacted.make(db.connInfo.password)
  });
  runtime = ManagedRuntime.make(Layer.provide(ViewProgressHubLive, pgLayer) as unknown as Layer.Layer<ViewProgressHub, never>);
  await runtime.runPromise(Effect.flatMap(ViewProgressHub, () => Effect.void)); // build it
}, { timeout: 60_000 });
after(async () => {
  await runtime.dispose();
  await admin.end();
  await db.stop();
});

const ping = (id: string, n: number) => JSON.stringify({ id, transactionId: String(n), position: String(n) });
const notify = (payload: string) => admin.query("SELECT pg_notify($1, $2)", [VIEW_PROGRESS_CHANNEL, payload]);
const waitUntil = async (check: () => Promise<boolean>, ms = 15_000) => {
  const start = Date.now();
  while (!(await check())) {
    if (Date.now() - start > ms) throw new Error("condition not reached in time");
    await new Promise((r) => setTimeout(r, 25));
  }
};
const listeners = async () => Number((await admin.query("SELECT count(*) AS n FROM pg_stat_activity WHERE query LIKE 'LISTEN %' AND pid <> pg_backend_pid()")).rows[0].n);
const run = <A>(effect: Effect.Effect<A, unknown, Scope.Scope | ViewProgressHub>) => runtime.runPromise(Effect.scoped(effect) as Effect.Effect<A, unknown, ViewProgressHub>);

describe("the view progress hub over a real LISTEN", () => {
  it("a ping sent by the database reaches the subscriber of that view, and not the subscriber of another", { timeout: 30_000 }, async () => {
    await run(
      Effect.gen(function* () {
        const hub = yield* ViewProgressHub;
        yield* Effect.promise(() => waitUntil(() => Effect.runPromise(hub.connected)));
        const mine = yield* hub.subscribe(new Set(["wallet-balance"]));
        const other = yield* hub.subscribe(new Set(["wallet-summary"]));
        yield* Effect.promise(() => notify(ping("wallet-balance", 41)));
        const batch = yield* mine.next;
        assert.deepStrictEqual(batch.pings, [{ id: "wallet-balance", transactionId: "41", position: "41" }]);
        assert.strictEqual(batch.resync, false);
        const silent = yield* Effect.exit(Effect.timeout(other.next, "300 millis"));
        assert.strictEqual(silent._tag, "Failure", "the other view's subscriber was not woken");
      })
    );
  });

  it("300 subscribers share ONE database connection", { timeout: 30_000 }, async () => {
    await run(
      Effect.gen(function* () {
        const hub = yield* ViewProgressHub;
        yield* Effect.promise(() => waitUntil(() => Effect.runPromise(hub.connected)));
        const subs = [];
        for (let n = 0; n < 300; n++) subs.push(yield* hub.subscribe(new Set(["v"])));
        assert.strictEqual(yield* hub.subscriberCount, 300);
        assert.strictEqual(yield* Effect.promise(listeners), 1, "one LISTEN session, however many subscribers");
        yield* Effect.promise(() => notify(ping("v", 7)));
        for (const s of subs) assert.strictEqual((yield* s.next).pings[0]!.position, "7");
      })
    );
  });

  it("when the database connection is killed the hub reconnects, tells every subscriber to re-read, and pings flow again", { timeout: 60_000 }, async () => {
    await run(
      Effect.gen(function* () {
        const hub = yield* ViewProgressHub;
        yield* Effect.promise(() => waitUntil(() => Effect.runPromise(hub.connected)));
        const a = yield* hub.subscribe(new Set(["a"]));
        const b = yield* hub.subscribe(null);

        const killed = yield* Effect.promise(() =>
          admin.query("SELECT pg_terminate_backend(pid) AS ok FROM pg_stat_activity WHERE query LIKE 'LISTEN %' AND pid <> pg_backend_pid()")
        );
        assert.strictEqual(killed.rowCount, 1, "exactly the hub's session was terminated");

        assert.strictEqual((yield* a.next).resync, true);
        assert.strictEqual((yield* b.next).resync, true);
        yield* Effect.promise(() => waitUntil(() => Effect.runPromise(hub.connected)));
        assert.strictEqual(yield* Effect.promise(listeners), 1, "one new LISTEN session");

        yield* Effect.promise(() => notify(ping("a", 99)));
        assert.deepStrictEqual((yield* a.next).pings, [{ id: "a", transactionId: "99", position: "99" }]);
      })
    );
  });
});
