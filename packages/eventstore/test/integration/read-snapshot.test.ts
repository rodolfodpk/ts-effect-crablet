// Runs under Node (Testcontainers). The snapshot a read carries (ADR-0048), against Postgres itself:
// - with transactions running, the append's test for "the read could not see it" (from xmax on, or running: crablet_items_match_any in V6) gives what
//   NOT pg_visible_in_snapshot gives, for every xid around the snapshot; and ReadSnapshot.sees agrees with pg_visible_in_snapshot;
// - the intersection of two real snapshots is a snapshot Postgres reads, and sees in it what it sees in both.
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { Client } from "pg";
import { startTestDb, type TestDb } from "@crablet/test-support";
import * as ReadSnapshot from "../../src/ReadSnapshot.ts";

let db: TestDb;
before(async () => { db = await startTestDb(); }, { timeout: 60_000 });
after(async () => { await db.stop(); });

const connect = async () => {
  const c = new Client({ host: db.connInfo.host, port: db.connInfo.port, database: db.connInfo.database, user: db.connInfo.username, password: db.connInfo.password });
  await c.connect();
  return c;
};
const snapshotOf = async (c: Client) => ReadSnapshot.fromText((await c.query<{ s: string }>("SELECT pg_current_snapshot()::text AS s")).rows[0]!.s);
// A transaction that takes an xid and stays open: it is in the snapshots taken meanwhile.
const openWithXid = async () => {
  const c = await connect();
  await c.query("BEGIN");
  const xid = BigInt((await c.query<{ x: string }>("SELECT pg_current_xact_id()::text AS x")).rows[0]!.x);
  return { c, xid, close: async () => { await c.query("COMMIT"); await c.end(); } };
};
// Finished transactions with xids, so the snapshot's range holds both seen and unseen ones.
const commitSome = async (c: Client, n: number) => {
  for (let i = 0; i < n; i++) await c.query("SELECT pg_current_xact_id()");
};

describe("the read's snapshot in Postgres", () => {
  it("the append's test agrees with NOT pg_visible_in_snapshot, and ReadSnapshot.sees with pg_visible_in_snapshot", async () => {
    const reader = await connect();
    const running = [await openWithXid()];
    await commitSome(reader, 3);
    running.push(await openWithXid());
    await commitSome(reader, 2);
    try {
      const snap = await snapshotOf(reader);
      assert.ok(ReadSnapshot.parse(snap).xip.length >= 2, `two transactions are running in ${snap}`);
      const { xmin, xmax } = ReadSnapshot.parse(snap);
      const rows = (await reader.query<{ xid: string; visible: boolean; unseen: boolean }>(
        `SELECT x::text AS xid, pg_visible_in_snapshot(x::text::xid8, $1::pg_snapshot) AS visible,
                (x::text::xid8 >= pg_snapshot_xmax($1::pg_snapshot) OR x::text::xid8 = ANY (ARRAY(SELECT pg_snapshot_xip($1::pg_snapshot)))) AS unseen
         FROM generate_series($2::bigint, $3::bigint) AS x`,
        [snap, (xmin - 5n).toString(), (xmax + 5n).toString()]
      )).rows;
      for (const r of rows) {
        assert.strictEqual(r.unseen, !r.visible, `xid ${r.xid} in ${snap}`);
        assert.strictEqual(ReadSnapshot.sees(snap, BigInt(r.xid)), r.visible, `xid ${r.xid} in ${snap}`);
      }
    } finally {
      await Promise.all(running.map((t) => t.close()));
      await reader.end();
    }
  });

  it("the intersection of two real snapshots is read by Postgres, and sees there what both see", async () => {
    const reader = await connect();
    const first = await openWithXid();
    const a = await snapshotOf(reader); // first is running
    await first.close();
    const second = await openWithXid();
    await commitSome(reader, 2);
    const b = await snapshotOf(reader); // first has finished, second is running
    try {
      const both = ReadSnapshot.intersect(a, b);
      const lo = ReadSnapshot.parse(both).xmin - 3n, hi = ReadSnapshot.parse(b).xmax + 3n;
      const rows = (await reader.query<{ xid: string; a: boolean; b: boolean; both: boolean }>(
        `SELECT x::text AS xid, pg_visible_in_snapshot(x::text::xid8, $1::pg_snapshot) AS a, pg_visible_in_snapshot(x::text::xid8, $2::pg_snapshot) AS b,
                pg_visible_in_snapshot(x::text::xid8, $3::pg_snapshot) AS both
         FROM generate_series($4::bigint, $5::bigint) AS x`,
        [a, b, both, lo.toString(), hi.toString()]
      )).rows;
      assert.ok(rows.some((r) => r.a !== r.b), `the two snapshots differ somewhere (${a}, ${b})`);
      for (const r of rows) assert.strictEqual(r.both, r.a && r.b, `xid ${r.xid}: ${a} and ${b} give ${both}`);
      assert.ok(!ReadSnapshot.sees(both, first.xid), "running in the first snapshot, so not seen by the intersection, though the second saw it finish");
    } finally {
      await second.close();
      await reader.end();
    }
  });
});
