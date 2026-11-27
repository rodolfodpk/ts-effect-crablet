// Runs under Node (Testcontainers). The two view progress hubs are one service (ADR-0016): `ViewProgressHubLive` hears the progress pings over LISTEN,
// `viewProgressPolling` reads the progress table. The same scenarios run against both: a subscriber hears a view that moved, the feed opens with
// where the view is and then follows it, and a read's wait ends when the view reaches the write.
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { Effect, Exit, Fiber, Layer, ManagedRuntime, Option, Redacted, Scope, Stream } from "effect";
import { SqlClient } from "effect/sql";
import { PgClient } from "@effect/sql-pg";
import { startTestDb, type TestDb } from "@crablet/test-support";
import { EventStore, EventStoreLive } from "@crablet/eventstore";
import * as AppendEvent from "@crablet/eventstore/AppendEvent";
import { type ProcessConnections, ProcessConnectionsLive } from "@crablet/eventstore/ProcessConnections";
import type { ProgressCursor } from "@crablet/event-poller/ProgressCursor";
import { VIEW_PROGRESS_CHANNEL } from "../../src/ViewProgress.ts";
import { makeViewProgressHub, pollingProgressSource, ViewProgressHub, ViewProgressHubLive, viewProgressPolling } from "../../src/ViewProgressHub.ts";
import { viewProgressFeed } from "../../src/ViewProgressFeed.ts";
import { viewSubscriptionOf } from "../../src/ViewSubscription.ts";
import { waitUntilProcessed } from "../../src/WaitUntilProcessed.ts";

type Services = EventStore | SqlClient.SqlClient | PgClient.PgClient | ProcessConnections;
let db: TestDb;
let runtime: ManagedRuntime.ManagedRuntime<Services, never>;

before(async () => {
  db = await startTestDb();
  const pgLayer = PgClient.layer({
    host: db.connInfo.host,
    port: db.connInfo.port,
    database: db.connInfo.database,
    username: db.connInfo.username,
    password: Redacted.make(db.connInfo.password)
  });
  runtime = ManagedRuntime.make(Layer.provideMerge(Layer.merge(EventStoreLive, ProcessConnectionsLive), pgLayer).pipe(Layer.orDie));
}, { timeout: 60_000 });
after(async () => {
  await runtime.dispose();
  await db.stop();
});

const hubs: ReadonlyArray<readonly [string, Layer.Layer<ViewProgressHub, never, Services>]> = [
  ["ViewProgressHubLive (LISTEN)", ViewProgressHubLive],
  ["viewProgressPolling (the progress table)", viewProgressPolling({ interval: "20 millis" })]
];

// A view with progress at the start, and an event of its type appended now (the write a read would wait for).
const aView = Effect.gen(function* () {
  const id = crypto.randomUUID().slice(0, 8);
  const name = `hubs-${id}`;
  const type = `Hubs-${id}`;
  const sql = yield* SqlClient.SqlClient;
  yield* sql.unsafe("INSERT INTO crablet_view_progress (view_name) VALUES ($1)", [name]);
  const appended = yield* Effect.flatMap(EventStore, (es) => es.append([AppendEvent.of(type, "row", id, {})]));
  const write: ProgressCursor = { transactionId: appended.transactionId, position: appended.lastPosition };
  return { name, write, subscription: viewSubscriptionOf(name, { eventTypes: new Set([type]) }) };
});

// What a view's tracker does when it advances: the update and the ping in one statement.
const advance = (name: string, to: ProgressCursor) =>
  Effect.flatMap(SqlClient.SqlClient, (sql) =>
    sql.unsafe(
      `WITH updated AS (
         UPDATE crablet_view_progress SET last_position = $2, last_transaction_id = $3::xid8 WHERE view_name = $1
         RETURNING view_name AS id, last_transaction_id::text AS transaction_id, last_position::text AS position)
       SELECT pg_notify($4, json_build_object('id', id, 'transactionId', transaction_id, 'position', position)::text) FROM updated`,
      [name, to.position.toString(), to.transactionId, VIEW_PROGRESS_CHANNEL]
    )
  );

const untilConnected = Effect.flatMap(ViewProgressHub, (hub) => Effect.repeat(hub.connected, { until: (connected) => connected }));

const withHub = <A, E>(hub: Layer.Layer<ViewProgressHub, never, Services>, body: Effect.Effect<A, E, Services | ViewProgressHub | Scope.Scope>) =>
  runtime.runPromise(Effect.scoped(Effect.provide(Effect.andThen(untilConnected, body), hub)));

for (const [name, hub] of hubs) {
  describe(name, () => {
    it("a subscriber hears the view that moved, with where it got to", { timeout: 20_000 }, async () => {
      await withHub(
        hub,
        Effect.gen(function* () {
          const view = yield* aView;
          const pings = yield* Effect.flatMap(ViewProgressHub, (h) => h.subscribe(new Set([view.name])));
          yield* advance(view.name, view.write);
          // Before it: the resync of the hub's connect, and, from the table, the view's new row at the start (the polling hub announces a row it has
          // not seen, so a view registered and advanced within one interval is not missed). The ping for the write follows.
          for (;;) {
            const batch = yield* Effect.timeoutOption(pings.next, "5 seconds");
            assert.ok(Option.isSome(batch), "a batch within 5 s");
            const ping = batch.value.pings.find((p) => p.id === view.name && p.position === String(view.write.position));
            if (ping === undefined) continue;
            assert.deepStrictEqual(ping, { id: view.name, transactionId: view.write.transactionId, position: String(view.write.position) });
            return;
          }
        })
      );
    });

    it("the feed opens with where the view is, then follows it", { timeout: 20_000 }, async () => {
      await withHub(
        hub,
        Effect.gen(function* () {
          const view = yield* aView;
          const seen: Array<string> = [];
          const fiber = yield* viewProgressFeed(new Set([view.name])).pipe(
            Stream.runForEach((ping) => Effect.sync(() => void seen.push(ping.position))),
            Effect.forkScoped
          );
          yield* Effect.repeat(Effect.sync(() => seen.length), { until: (n) => n >= 1 });
          assert.strictEqual(seen[0], "0", "it opens at the start");
          yield* advance(view.name, view.write);
          yield* Effect.repeat(Effect.sync(() => seen.includes(String(view.write.position))), { until: (moved) => moved }).pipe(Effect.timeout("5 seconds"));
          yield* Fiber.interrupt(fiber);
        })
      );
    });

    it("a wait for the write ends once the view reaches it, woken by the hub", { timeout: 20_000 }, async () => {
      await withHub(
        hub,
        Effect.gen(function* () {
          const view = yield* aView;
          const started = Date.now();
          const waiting = yield* Effect.forkScoped(waitUntilProcessed(view.subscription, view.write, { timeout: "10 seconds", safetyInterval: "10 seconds" }));
          yield* Effect.sleep("100 millis");
          yield* advance(view.name, view.write);
          const exit = yield* Fiber.await(waiting);
          assert.ok(Exit.isSuccess(exit), "the wait ended without a timeout");
          assert.ok(Date.now() - started < 2_000, `woken, not by the 10 s safety interval (${Date.now() - started} ms)`);
        })
      );
    });
  });
}

describe("viewProgressPolling", () => {
  it("a failed read of the table is a lost connection: the hub resyncs its subscribers and polls again", { timeout: 20_000 }, async () => {
    await runtime.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const view = yield* aView;
          const sql = yield* SqlClient.SqlClient;
          const reads = { n: 0 };
          // the second read of the table fails, as a dropped connection would; every other read goes through
          const flaky = new Proxy(sql, {
            get(target, property) {
              const value = Reflect.get(target, property, target);
              return property === "unsafe"
                ? (...args: Array<unknown>) =>
                    ++reads.n === 2 ? sql.unsafe("SELECT * FROM crablet_no_such_table") : (value as (...a: Array<unknown>) => unknown).apply(target, args)
                : value;
            }
          });
          const hub = yield* makeViewProgressHub({ source: pollingProgressSource(flaky, "20 millis"), retryBase: "10 millis" });
          const pings = yield* hub.subscribe(new Set([view.name]));
          // Whether this subscriber came before or after the first connect, a resync must come once the failed read is behind: the hub connected again.
          for (;;) {
            const batch = yield* Effect.timeoutOption(pings.next, "5 seconds");
            assert.ok(Option.isSome(batch), "a resync within 5 s of the failed read");
            if (batch.value.resync && reads.n >= 3) break;
          }
          yield* advance(view.name, view.write);
          for (;;) {
            const batch = yield* Effect.timeoutOption(pings.next, "5 seconds");
            assert.ok(Option.isSome(batch));
            if (batch.value.pings.some((p) => p.id === view.name)) break;
          }
          assert.ok(reads.n >= 3, "it kept reading after the failure");
        })
      )
    );
  });
});
