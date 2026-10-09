// Runs under Node (Testcontainers). ADR-0021: appends do not notify; one notification per window goes out after the commit. No wake-up may be lost, none may precede the commit,
// and a rolled-back transaction sends nothing.
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { Effect, Fiber, Layer, Redacted, Ref, Stream } from "effect";
import { SqlClient } from "effect/sql";
import { PgClient } from "@effect/sql-pg";
import { startTestDb, type TestDb } from "@crablet/test-support";
import { EventStore, EVENTS_CHANNEL, makeEventStoreLayer, type EventStoreConfig } from "../../src/EventStore.ts";
import { wakeupStream } from "../../src/Listen.ts";
import * as AppendEvent from "../../src/AppendEvent.ts";

let db: TestDb;
let pgLayer: Layer.Layer<PgClient.PgClient | SqlClient.SqlClient, never>;
before(async () => {
  db = await startTestDb();
  pgLayer = PgClient.layer({ host: db.connInfo.host, port: db.connInfo.port, database: db.connInfo.database, username: db.connInfo.username, password: Redacted.make(db.connInfo.password) }) as unknown as Layer.Layer<PgClient.PgClient | SqlClient.SqlClient, never>;
}, { timeout: 60_000 });
after(async () => { await db.stop(); });

const run = <A>(config: EventStoreConfig, effect: Effect.Effect<A, unknown, EventStore | SqlClient.SqlClient | PgClient.PgClient>) =>
  Effect.runPromise(Effect.provide(effect, Layer.provideMerge(makeEventStoreLayer(config), pgLayer)) as Effect.Effect<A, never, never>);

// Collects what the listener hears: every batch with the time it arrived and what was committed at that moment, per type.
const listen = (committedCount: (type: string) => Effect.Effect<number, unknown, SqlClient.SqlClient>) =>
  Effect.gen(function* () {
    const pg = yield* PgClient.PgClient;
    const heard = yield* Ref.make<ReadonlyArray<{ readonly types: ReadonlyArray<string>; readonly committed: Record<string, number> }>>([]);
    const fiber = yield* Effect.forkChild(
      Stream.runForEach(wakeupStream(pg, EVENTS_CHANNEL), (batch) =>
        Effect.gen(function* () {
          const types = [...batch.types];
          const committed: Record<string, number> = {};
          for (const t of types) committed[t] = yield* committedCount(t);
          yield* Ref.update(heard, (xs) => [...xs, { types, committed }]);
        })
      )
    );
    yield* Effect.sleep("300 millis"); // LISTEN registered
    return { heard: Ref.get(heard), stop: Fiber.interrupt(fiber) };
  });

const committed = (type: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql.unsafe<{ n: string }>("SELECT count(*)::text AS n FROM crablet_events WHERE type = $1", [type]);
    return Number(rows[0]!.n);
  });

describe("wake-ups after the commit, coalesced (ADR-0021)", () => {
  it("many concurrent commands: every appended event type is announced, in fewer notifications than commands", { timeout: 60_000 }, async () => {
    const N = 200;
    const run1 = crypto.randomUUID().slice(0, 8);
    const result = await run({ wakeupMode: "coalesced", wakeupWindowMs: 50 }, Effect.gen(function* () {
      const store = yield* EventStore;
      const sql = yield* SqlClient.SqlClient;
      const l = yield* listen(committed);
      yield* Effect.forEach(
        Array.from({ length: N }, (_, i) => i),
        (i) => store.withWakeups(sql.withTransaction(store.append([AppendEvent.of(`W${run1}x${i}`, "wake_id", `${run1}-${i}`, {})]))),
        { concurrency: 32, discard: true }
      );
      yield* Effect.sleep("400 millis"); // window + listener debounce
      const heard = yield* l.heard;
      yield* l.stop;
      return heard;
    }));
    const announced = new Set(result.flatMap((b) => b.types));
    for (let i = 0; i < N; i++) assert.ok(announced.has(`W${run1}x${i}`), `type ${i} was announced`);
    assert.ok(result.length < N / 2, `coalesced: ${result.length} notifications for ${N} commands`);
  });

  it("the notification arrives after the commit: when it is heard, the event is already visible", { timeout: 30_000 }, async () => {
    const type = `Slow${crypto.randomUUID().slice(0, 8)}`;
    const heard = await run({ wakeupMode: "coalesced" }, Effect.gen(function* () {
      const store = yield* EventStore;
      const sql = yield* SqlClient.SqlClient;
      const l = yield* listen(committed);
      yield* store.withWakeups(sql.withTransaction(Effect.andThen(store.append([AppendEvent.of(type, "k", "v", {})]), Effect.sleep("500 millis"))));
      yield* Effect.sleep("300 millis");
      const h = yield* l.heard;
      yield* l.stop;
      return h;
    }));
    const mine = heard.filter((b) => b.types.includes(type));
    assert.ok(mine.length >= 1, "it was announced");
    for (const b of mine) assert.strictEqual(b.committed[type], 1, "and the event was committed by then");
  });

  it("a rolled-back transaction announces nothing", { timeout: 30_000 }, async () => {
    const type = `Rolled${crypto.randomUUID().slice(0, 8)}`;
    const heard = await run({ wakeupMode: "coalesced" }, Effect.gen(function* () {
      const store = yield* EventStore;
      const sql = yield* SqlClient.SqlClient;
      const l = yield* listen(committed);
      yield* Effect.exit(store.withWakeups(sql.withTransaction(Effect.andThen(store.append([AppendEvent.of(type, "k", "v", {})]), Effect.fail("boom")))));
      yield* Effect.sleep("400 millis");
      const h = yield* l.heard;
      yield* l.stop;
      return h;
    }));
    assert.deepStrictEqual(heard.filter((b) => b.types.includes(type)), []);
  });

  it("an append outside any transaction announces itself when it returns; after an idle spell it is at once", { timeout: 30_000 }, async () => {
    const type = `Plain${crypto.randomUUID().slice(0, 8)}`;
    const heard = await run({ wakeupMode: "coalesced", wakeupWindowMs: 50 }, Effect.gen(function* () {
      const store = yield* EventStore;
      const l = yield* listen(committed);
      yield* store.append([AppendEvent.of(type, "k", "v", {})]);
      yield* Effect.sleep("300 millis");
      const h = yield* l.heard;
      yield* l.stop;
      return h;
    }));
    assert.ok(heard.some((b) => b.types.includes(type)));
  });

  it("inline mode keeps the old behavior: the append itself notifies", { timeout: 30_000 }, async () => {
    const type = `Inline${crypto.randomUUID().slice(0, 8)}`;
    const heard = await run({ wakeupMode: "inline" }, Effect.gen(function* () {
      const store = yield* EventStore;
      const l = yield* listen(committed);
      yield* store.append([AppendEvent.of(type, "k", "v", {})]);
      yield* Effect.sleep("300 millis");
      const h = yield* l.heard;
      yield* l.stop;
      return h;
    }));
    assert.ok(heard.some((b) => b.types.includes(type)));
  });
});
