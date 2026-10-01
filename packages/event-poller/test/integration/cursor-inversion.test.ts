// Runs under Node (Testcontainers) - see NOTES.md.
// Reproduces the skipped-event hole (docs/plans/poller-cursor-fix.md, phase 1), deterministically.
//
// `position` comes from nextval() when a row is inserted, `transaction_id` is the xid of the inserting
// transaction, and the two can be taken in opposite orders: T1 gets the LOWER xid but the HIGHER
// position, T2 the other way round. If T1 commits while T2 is still open, xmin is T2's xid, so T1's row
// is visible and the poller moves its cursor to T1's row. When T2 commits, its row has a lower position but a
// higher xid: a position cursor never delivers it, a (transaction_id, position) cursor does.
// (Note: nextval() itself assigns the calling transaction an xid, so T2 is "in flight" from then on.)
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { Client } from "pg";
import { Effect, Layer, Redacted } from "effect";
import { SqlClient } from "effect/sql";
import { PgClient } from "@effect/sql-pg";
import { startTestDb, type TestDb } from "@crablet/test-support";
import { EventStore, EventStoreLive } from "@crablet/eventstore";
import * as AppendEvent from "@crablet/eventstore/AppendEvent";
import { makeSqlEventFetcher } from "../../src/SqlEventFetcher.ts";
import * as EventSelection from "../../src/EventSelection.ts";
import * as ProgressCursorNS from "../../src/ProgressCursor.ts";
import type { ProgressCursor } from "../../src/ProgressCursor.ts";

let db: TestDb;
let layer: Layer.Layer<EventStore | SqlClient.SqlClient, never>;

const connect = async (): Promise<Client> => {
  const c = new Client({
    host: db.connInfo.host,
    port: db.connInfo.port,
    database: db.connInfo.database,
    user: db.connInfo.username,
    password: db.connInfo.password
  });
  await c.connect();
  return c;
};

before(async () => {
  db = await startTestDb();
  const pgLayer = PgClient.layer({
    host: db.connInfo.host,
    port: db.connInfo.port,
    database: db.connInfo.database,
    username: db.connInfo.username,
    password: Redacted.make(db.connInfo.password)
  });
  layer = Layer.provideMerge(EventStoreLive, pgLayer) as unknown as Layer.Layer<
    EventStore | SqlClient.SqlClient,
    never
  >;
}, { timeout: 60_000 });

after(async () => {
  await db.stop();
});

const run = <A, E>(effect: Effect.Effect<A, E, EventStore | SqlClient.SqlClient>) =>
  Effect.runPromise(Effect.provide(effect, layer) as Effect.Effect<A, E, never>);

const fetchAfter = (cursor: ProgressCursor) =>
  run(
    Effect.gen(function* () {
      const fetcher = yield* makeSqlEventFetcher<string>(EventSelection.of({ eventTypes: new Set(["InvA", "InvB"]) }));
      return yield* fetcher.fetchEvents("proc", cursor, 1000);
    })
  );

describe("poller cursor vs. out-of-order position/xid", () => {
  it("a row whose position is below the cursor but whose xid is above the delivered ones is still delivered", async () => {
    const t1 = await connect();
    const t2 = await connect();
    try {
      // T1 takes the lower xid first.
      await t1.query("BEGIN");
      const xid1 = (await t1.query("SELECT pg_current_xact_id()::text AS x")).rows[0].x as string;

      // T2 reserves a position (this assigns T2 an xid, above T1's).
      await t2.query("BEGIN");
      const pT2 = BigInt((await t2.query("SELECT nextval('crablet_events_position_seq') AS p")).rows[0].p);
      const xid2 = (await t2.query("SELECT pg_current_xact_id_if_assigned()::text AS x")).rows[0].x as string;
      assert.ok(BigInt(xid2) > BigInt(xid1), "T2's xid is above T1's");

      // T1 now inserts (the default position is taken now, so it is above T2's) and commits.
      await t1.query(
        `INSERT INTO crablet_events (type, tags, data, transaction_id)
         VALUES ('InvB', ARRAY['case=inversion'], '{}'::jsonb, pg_current_xact_id())`
      );
      await t1.query("COMMIT");

      // T2 is still open, so xmin is T2's xid and T1's row is visible: the poller reads it, cursor := its position.
      const first = await fetchAfter(ProgressCursorNS.zero);
      assert.deepStrictEqual(first.map((e) => e.type), ["InvB"]);
      const cursor = ProgressCursorNS.after(first[first.length - 1]!);
      assert.ok(cursor.position > pT2, "T1's position is above T2's reserved one");

      // T2 writes its row at its reserved (lower) position and commits.
      await t2.query(
        `INSERT INTO crablet_events (position, type, tags, data, transaction_id)
         VALUES ($1, 'InvA', ARRAY['case=inversion'], '{}'::jsonb, pg_current_xact_id())`,
        [pT2.toString()]
      );
      await t2.query("COMMIT");

      // The row is committed and visible; a correct poller must deliver it: (x2, p2) sorts after (x1, p1).
      const second = await fetchAfter(cursor);
      assert.deepStrictEqual(second.map((e) => e.type), ["InvA"]);
    } finally {
      await t1.end();
      await t2.end();
    }
  });
});
