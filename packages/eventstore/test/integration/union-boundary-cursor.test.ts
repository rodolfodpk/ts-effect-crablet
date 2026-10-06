// Runs under Node (Testcontainers) - see NOTES.md. Which cursor is a SAFE append condition for a model over SEVERAL entities (`all(...)`, ADR-0018 open point 1)?
//
// The check refuses an append when an event matching the union boundary sorts after the cursor in (transaction_id, position) order. It is safe only if
// every event that a member's read did NOT see sorts after the cursor, and live (never refuses forever) only if the events every member DID see sort at
// or before it. A read at snapshot S sees everything with transaction_id below S's xmin (those transactions had finished) and may miss anything at or
// above it. So the safe cursors are the ones whose transaction id is below the xmin of EVERY member's read: `(min xmin, 0)`, "the horizon".
// Three candidates, each tried on the interleaving that breaks or keeps it:
//   max of the members' last settled events  -> can sit above an event another member's earlier read missed: a LOST conflict (unsafe)
//   min of the members' last settled events  -> sits below events every member saw: refuses for ever (not live)
//   min of the members' read horizons        -> safe, and refuses exactly the events at or above the oldest xmin, as a single model does today
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { Client } from "pg";
import { startTestDb, type TestDb } from "@crablet/test-support";

let db: TestDb;
const connect = async () => {
  const c = new Client({ host: db.connInfo.host, port: db.connInfo.port, database: db.connInfo.database, user: db.connInfo.username, password: db.connInfo.password });
  await c.connect();
  return c;
};
before(async () => { db = await startTestDb(); }, { timeout: 60_000 });
after(async () => { await db.stop(); });

interface Cursor { readonly xid: string; readonly position: string }
interface Load { readonly horizon: Cursor; readonly lastSettled: Cursor | null }
const lessThan = (a: Cursor, b: Cursor) => (BigInt(a.xid) !== BigInt(b.xid) ? BigInt(a.xid) < BigInt(b.xid) : BigInt(a.position) < BigInt(b.position));

// What a member's load observes at one instant: the horizon (xmin of a snapshot taken BEFORE the read, so never above the read's own) and the last
// settled event of its boundary. Autocommit statements on a connection of their own, as a command's reads are.
const load = async (c: Client, tag: string): Promise<Load> => {
  const h = await c.query("SELECT pg_snapshot_xmin(pg_current_snapshot())::text AS xmin");
  const rows = await c.query(
    "SELECT transaction_id::text AS x, position::text AS p, (transaction_id < pg_snapshot_xmin(pg_current_snapshot())) AS settled FROM crablet_events WHERE tags @> ARRAY[$1]::text[] ORDER BY transaction_id, position",
    [tag]
  );
  const settled = rows.rows.filter((r) => r.settled);
  const last = settled[settled.length - 1];
  return { horizon: { xid: h.rows[0].xmin, position: "0" }, lastSettled: last ? { xid: last.x, position: last.p } : null };
};
const conflicts = async (c: Client, tags: ReadonlyArray<string>, cursor: Cursor) =>
  (await c.query("SELECT crablet_items_match_any($1::jsonb, $2::bigint, $3::xid8) AS hit", [JSON.stringify(tags.map((t) => ({ types: [], tags: [t] }))), cursor.position, cursor.xid])).rows[0].hit as boolean;
const insert = (c: Client, tag: string) =>
  c.query("INSERT INTO crablet_events (type, tags, data, transaction_id) VALUES ('E', ARRAY[$1]::text[], '{}'::jsonb, pg_current_xact_id())", [tag]);
const maxOf = (cs: ReadonlyArray<Cursor>) => cs.reduce((a, b) => (lessThan(a, b) ? b : a));
const minOf = (cs: ReadonlyArray<Cursor>) => cs.reduce((a, b) => (lessThan(a, b) ? a : b));

describe("the cursor of an append condition over a union boundary", () => {
  it("max of the members' last events can skip an event an earlier member read missed; the minimum horizon refuses it", { timeout: 30_000 }, async () => {
    const [w2, w1, reader, checker] = [await connect(), await connect(), await connect(), await connect()];
    const a = `a=${crypto.randomUUID()}`, b = `b=${crypto.randomUUID()}`;
    try {
      await w2.query("BEGIN");
      await insert(w2, b); // e2: member B's event, in a transaction with the LOWER xid, not yet committed
      const loadB = await load(reader, b); // B's read cannot see e2
      await w2.query("COMMIT");
      await insert(w1, a); // e1: member A's event, a HIGHER xid, committed
      const loadA = await load(reader, a); // A's read, later, sees e1 settled
      assert.ok(loadA.lastSettled, "A saw its event as settled");
      assert.strictEqual(loadB.lastSettled, null, "B did not see e2");

      const maxCursor = maxOf([loadA.lastSettled!, ...(loadB.lastSettled ? [loadB.lastSettled] : [])]);
      assert.strictEqual(await conflicts(checker, [a, b], maxCursor), false, "UNSAFE: with this cursor the append would be accepted over a state that lacks e2");
      const horizon = minOf([loadA.horizon, loadB.horizon]);
      assert.strictEqual(await conflicts(checker, [a, b], horizon), true, "the horizon of the oldest read refuses it, so the command is retried with e2");
    } finally {
      await Promise.all([w2, w1, reader, checker].map((c) => c.end()));
    }
  });

  it("min of the members' last events refuses for ever in a quiet database; the minimum horizon does not", { timeout: 30_000 }, async () => {
    const [w, reader, checker] = [await connect(), await connect(), await connect()];
    const a = `a=${crypto.randomUUID()}`, b = `b=${crypto.randomUUID()}`;
    try {
      await insert(w, b); // older
      await insert(w, a); // newer; nothing is running, both are settled and both were seen
      const [loadA, loadB] = [await load(reader, a), await load(reader, b)];
      const minCursor = minOf([loadA.lastSettled!, loadB.lastSettled!]);
      assert.strictEqual(await conflicts(checker, [a, b], minCursor), true, "NOT LIVE: A's event, which A's state includes, sorts above this cursor, so it is refused on every retry");
      const horizon = minOf([loadA.horizon, loadB.horizon]);
      assert.strictEqual(await conflicts(checker, [a, b], horizon), false, "the horizon accepts: everything either member saw is below it");
    } finally {
      await Promise.all([w, reader, checker].map((c) => c.end()));
    }
  });

  it("with an older transaction open, the horizon refuses the same events a single model's last-settled cursor refuses: no worse than today", { timeout: 30_000 }, async () => {
    const [old, w, reader, checker] = [await connect(), await connect(), await connect(), await connect()];
    const a = `a=${crypto.randomUUID()}`, b = `b=${crypto.randomUUID()}`;
    try {
      await old.query("BEGIN");
      await old.query("SELECT pg_current_xact_id()"); // an unrelated open transaction pins xmin
      await insert(w, a); // committed, but above xmin: not settled
      await insert(w, b);
      const [loadA, loadB] = [await load(reader, a), await load(reader, b)];
      assert.strictEqual(loadA.lastSettled, null);
      assert.strictEqual(loadB.lastSettled, null);
      // today, each single model's cursor is "none" (nothing settled), which refuses anything matching: the same events as the horizon
      assert.strictEqual(await conflicts(checker, [a], { xid: "0", position: "0" }), true);
      assert.strictEqual(await conflicts(checker, [a, b], minOf([loadA.horizon, loadB.horizon])), true);
      await old.query("COMMIT");
      // once it ends, a fresh load accepts
      const [afterA, afterB] = [await load(reader, a), await load(reader, b)];
      assert.strictEqual(await conflicts(checker, [a, b], minOf([afterA.horizon, afterB.horizon])), false);
    } finally {
      await Promise.all([old, w, reader, checker].map((c) => c.end()));
    }
  });
});
