// Runs under Node (Testcontainers). Loading a snapshotted model against real Postgres (ADR-0018): snapshot + tail equals the full fold, and a snapshot never
// contains events that sit above its cursor (events committed but not yet settled).
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { Client } from "pg";
import { Effect, Layer, Redacted } from "effect";
import * as Schema from "effect/Schema";
import { PgClient } from "@effect/sql-pg";
import { startTestDb, type TestDb } from "@crablet/test-support";
import { EventStore, EventStoreLive } from "@crablet/eventstore";
import { SnapshotCollectorLive, SnapshotStore, SnapshotStoreLive, canonicalQuery, flushSnapshots } from "@crablet/eventstore/SnapshotStore";
import { defineEvent } from "../../src/Event.ts";
import { defineModel } from "../../src/Model.ts";

const Opened = defineEvent("Opened", { schema: Schema.Struct({ accountId: Schema.String, initial: Schema.Number }), tags: (d) => ({ account_id: d.accountId }) });
const Deposited = defineEvent("Deposited", { schema: Schema.Struct({ accountId: Schema.String, amount: Schema.Number }), tags: (d) => ({ account_id: d.accountId }) });
const State = Schema.Struct({ balance: Schema.Number, events: Schema.Number });
const base = () =>
  defineModel({ by: "account_id", initial: () => ({ balance: 0, events: 0 }) })
    .on(Opened, (a, d) => ({ balance: d.initial, events: a.events + 1 }))
    .on(Deposited, (a, d) => ({ balance: a.balance + d.amount, events: a.events + 1 }));
const Plain = base();
const Snap = base().snapshot({ name: "account", version: 1, schema: State, every: 3 });

let db: TestDb;
let layer: Layer.Layer<EventStore | SnapshotStore, never>;
before(async () => {
  db = await startTestDb();
  layer = Layer.mergeAll(
    Layer.provideMerge(Layer.mergeAll(EventStoreLive, SnapshotStoreLive), PgClient.layer({ host: db.connInfo.host, port: db.connInfo.port, database: db.connInfo.database, username: db.connInfo.username, password: Redacted.make(db.connInfo.password) })),
    SnapshotCollectorLive
  ) as unknown as Layer.Layer<EventStore | SnapshotStore, never>;
}, { timeout: 60_000 });
after(async () => { await db.stop(); });

const run = <A, E>(e: Effect.Effect<A, E, any>) => Effect.runPromise(Effect.provide(e, layer) as Effect.Effect<A, E, never>);
const uid = () => crypto.randomUUID().slice(0, 8);
const append = (...events: Array<ReturnType<typeof Opened> | ReturnType<typeof Deposited>>) => Effect.flatMap(EventStore, (es) => es.append(events));
const loadSnap = (id: string) => Effect.flatMap(EventStore, (es) => Snap.of({ id }).load(es));
const loadPlain = (id: string) => Effect.flatMap(EventStore, (es) => Plain.of({ id }).load(es));
const stored = (id: string) => Effect.flatMap(SnapshotStore, (s) => s.get({ name: "account", version: 1, canonical: canonicalQuery(Snap.of({ id }).query) }));

describe("a snapshotted model on Postgres", () => {
  it("snapshot + tail gives the full fold's state and position, load after load", async () => {
    const id = `a-${uid()}`;
    const results = await run(Effect.gen(function* () {
      yield* append(Opened({ accountId: id, initial: 10 }), Deposited({ accountId: id, amount: 1 }), Deposited({ accountId: id, amount: 2 }));
      const first = yield* loadSnap(id);
      yield* flushSnapshots;
      yield* append(Deposited({ accountId: id, amount: 5 }));
      const second = yield* loadSnap(id); // tail of one event, below `every`
      yield* flushSnapshots;
      yield* append(Deposited({ accountId: id, amount: 1 }), Deposited({ accountId: id, amount: 1 }), Deposited({ accountId: id, amount: 1 }));
      const third = yield* loadSnap(id);
      yield* flushSnapshots;
      const reference = yield* loadPlain(id);
      return { first, second, third, reference, row: yield* stored(id) };
    }));
    assert.deepStrictEqual(results.third.state, results.reference.state);
    assert.strictEqual(results.third.logPosition.position, results.reference.logPosition.position);
    assert.deepStrictEqual(results.second.state, { balance: 18, events: 4 });
    assert.deepStrictEqual(results.row!.state, { balance: 21, events: 7 }, "the snapshot moved forward with the last load that folded 4 events");
  });

  it("a snapshot holds the state AT ITS CURSOR: events committed but not settled yet are not in it", async () => {
    const id = `a-${uid()}`;
    const pin = new Client({ host: db.connInfo.host, port: db.connInfo.port, database: db.connInfo.database, user: db.connInfo.username, password: db.connInfo.password });
    await pin.connect();
    try {
      await run(append(Opened({ accountId: id, initial: 0 }), Deposited({ accountId: id, amount: 1 }), Deposited({ accountId: id, amount: 1 }), Deposited({ accountId: id, amount: 1 }), Deposited({ accountId: id, amount: 1 }))); // 5 settled events
      await pin.query("BEGIN");
      await pin.query("SELECT pg_current_xact_id()"); // an older open transaction pins xmin: whatever commits now is above it, so not settled
      await run(append(Deposited({ accountId: id, amount: 1 }), Deposited({ accountId: id, amount: 1 }), Deposited({ accountId: id, amount: 1 }))); // 3 more, committed but unsettled
      const during = await run(Effect.gen(function* () {
        const loaded = yield* loadSnap(id);
        yield* flushSnapshots;
        return { loaded, row: yield* stored(id) };
      }));
      assert.deepStrictEqual(during.loaded.state, { balance: 7, events: 8 }, "the command's state includes the unsettled events (a conflict will make it retry)");
      assert.deepStrictEqual(during.row!.state, { balance: 4, events: 5 }, "the snapshot has only the 5 settled ones, matching its cursor");
      await pin.query("COMMIT");
      const after = await run(Effect.gen(function* () {
        return { withSnapshot: yield* loadSnap(id), reference: yield* loadPlain(id) };
      }));
      assert.deepStrictEqual(after.withSnapshot.state, after.reference.state, "no event is counted twice or lost");
      assert.deepStrictEqual(after.withSnapshot.state, { balance: 7, events: 8 });
    } finally {
      await pin.end();
    }
  });

  it("a snapshot that no longer decodes is ignored, and the next load replaces it", async () => {
    const id = `a-${uid()}`;
    const r = await run(Effect.gen(function* () {
      yield* append(Opened({ accountId: id, initial: 0 }), Deposited({ accountId: id, amount: 4 }), Deposited({ accountId: id, amount: 4 }));
      yield* Effect.flatMap(SnapshotStore, (s) => s.save({ name: "account", version: 1, canonical: canonicalQuery(Snap.of({ id }).query), cursor: { position: 1n, occurredAt: null, transactionId: "1" }, state: { balance: "oops" } }));
      const loaded = yield* loadSnap(id);
      yield* flushSnapshots;
      return { loaded, row: yield* stored(id) };
    }));
    assert.deepStrictEqual(r.loaded.state, { balance: 8, events: 3 });
    assert.deepStrictEqual(r.row!.state, { balance: 8, events: 3 }, "replaced: the new cursor is later than the bad row's");
  });
});
