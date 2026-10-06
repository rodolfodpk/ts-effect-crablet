// Runs under Node (Testcontainers) - see NOTES.md. SnapshotStoreLive against the V9 table (ADR-0018).
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { Effect, Layer, Redacted } from "effect";
import { SqlClient } from "effect/sql";
import { PgClient } from "@effect/sql-pg";
import { startTestDb, type TestDb } from "@crablet/test-support";
import * as Query from "../../src/Query.ts";
import { SnapshotStore, SnapshotStoreLive, canonicalQuery, type SnapshotKey } from "../../src/SnapshotStore.ts";

let db: TestDb;
let layer: Layer.Layer<SnapshotStore | SqlClient.SqlClient, never>;
before(async () => {
  db = await startTestDb();
  layer = Layer.provideMerge(
    SnapshotStoreLive,
    PgClient.layer({ host: db.connInfo.host, port: db.connInfo.port, database: db.connInfo.database, username: db.connInfo.username, password: Redacted.make(db.connInfo.password) })
  ) as unknown as Layer.Layer<SnapshotStore | SqlClient.SqlClient, never>;
}, { timeout: 60_000 });
after(async () => { await db.stop(); });

const run = <A, E>(e: Effect.Effect<A, E, SnapshotStore | SqlClient.SqlClient>) => Effect.runPromise(Effect.provide(e, layer) as Effect.Effect<A, E, never>);
const cursor = (xid: string, position: bigint) => ({ position, occurredAt: null, transactionId: xid });
const keyFor = (name: string, entity: string, version = 1): SnapshotKey => ({ name, version, canonical: canonicalQuery(Query.of(Query.queryItemOf(["Opened", "Deposited"], [{ key: "account_id", value: entity }]))) });

describe("SnapshotStore", () => {
  it("get finds nothing before the first save", async () => {
    assert.strictEqual(await run(Effect.flatMap(SnapshotStore, (s) => s.get(keyFor("none", "a")))), null);
  });

  it("round-trips the state and the cursor (position as bigint, transaction id as text)", async () => {
    const key = keyFor("rt", "a");
    const got = await run(Effect.gen(function* () {
      const s = yield* SnapshotStore;
      yield* s.save({ ...key, cursor: cursor("12345678901", 9007199254740993n), state: { balance: 7, nested: { ok: true } } });
      return yield* s.get(key);
    }));
    assert.deepStrictEqual(got, { state: { balance: 7, nested: { ok: true } }, cursor: cursor("12345678901", 9007199254740993n) });
  });

  it("save is forward-only and says whether it wrote", async () => {
    const key = keyFor("fwd", "a");
    const r = await run(Effect.gen(function* () {
      const s = yield* SnapshotStore;
      return [
        yield* s.save({ ...key, cursor: cursor("100", 10n), state: { n: 1 } }),
        yield* s.save({ ...key, cursor: cursor("100", 10n), state: { n: 2 } }),
        yield* s.save({ ...key, cursor: cursor("90", 50n), state: { n: 3 } }),
        yield* s.save({ ...key, cursor: cursor("110", 11n), state: { n: 4 } }),
        (yield* s.get(key))?.state
      ];
    }));
    assert.deepStrictEqual(r, [true, false, false, true, { n: 4 }]);
  });

  it("the key is the name, the version and the boundary query: another entity, version or model does not see the row; the order of the query's parts does not matter", async () => {
    const r = await run(Effect.gen(function* () {
      const s = yield* SnapshotStore;
      yield* s.save({ ...keyFor("k", "a"), cursor: cursor("1", 1n), state: "a" });
      const reordered: SnapshotKey = { name: "k", version: 1, canonical: canonicalQuery(Query.of(Query.queryItemOf(["Deposited", "Opened"], [{ key: "account_id", value: "a" }]))) };
      return [
        (yield* s.get(keyFor("k", "b")))?.state ?? null,
        (yield* s.get(keyFor("k", "a", 2)))?.state ?? null,
        (yield* s.get(keyFor("other", "a")))?.state ?? null,
        (yield* s.get(reordered))?.state ?? null
      ];
    }));
    assert.deepStrictEqual(r, [null, null, null, "a"]);
  });

  it("pruneOtherVersions removes the other versions of a model and nothing else", async () => {
    const r = await run(Effect.gen(function* () {
      const s = yield* SnapshotStore;
      for (const [name, version] of [["p", 1], ["p", 2], ["p", 3], ["q", 1]] as const) yield* s.save({ ...keyFor(name, "a", version), cursor: cursor("1", 1n), state: version });
      const removed = yield* s.pruneOtherVersions("p", 3);
      return { removed, kept: (yield* s.get(keyFor("p", "a", 3)))?.state, gone: yield* s.get(keyFor("p", "a", 1)), other: (yield* s.get(keyFor("q", "a", 1)))?.state };
    }));
    assert.deepStrictEqual(r, { removed: 2, kept: 3, gone: null, other: 1 });
  });
});
