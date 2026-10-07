// Runs under Node (Testcontainers) - see NOTES.md. Migration V9 (ADR-0018): the snapshot table and its forward-only save.
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { Client } from "pg";
import { startTestDb, type TestDb } from "@crablet/test-support";

let db: TestDb;
let c: Client;
before(async () => {
  db = await startTestDb();
  c = new Client({ host: db.connInfo.host, port: db.connInfo.port, database: db.connInfo.database, user: db.connInfo.username, password: db.connInfo.password });
  await c.connect();
}, { timeout: 60_000 });
after(async () => { await c.end(); await db.stop(); });

const save = async (name: string, version: number, fp: string, xid: string, pos: string, state: unknown) =>
  (await c.query("SELECT crablet_save_snapshot($1, $2, $3, $4::xid8, $5::bigint, $6::jsonb) AS written", [name, version, fp, xid, pos, JSON.stringify(state)])).rows[0].written as boolean;
const row = async (name: string, version: number, fp: string) =>
  (await c.query("SELECT transaction_id::text AS x, position::text AS p, state FROM crablet_model_snapshots WHERE name = $1 AND version = $2 AND fingerprint = $3", [name, version, fp])).rows[0];

describe("crablet_model_snapshots (V9)", () => {
  it("has the columns, types and key the ADR describes", async () => {
    const cols = (await c.query("SELECT column_name, data_type, is_nullable FROM information_schema.columns WHERE table_name = 'crablet_model_snapshots' ORDER BY ordinal_position")).rows;
    assert.deepStrictEqual(cols.map((r) => `${r.column_name}:${r.data_type}:${r.is_nullable}`), [
      "name:text:NO", "version:integer:NO", "fingerprint:text:NO", "transaction_id:xid8:NO", "position:bigint:NO", "state:jsonb:NO", "updated_at:timestamp with time zone:NO", "entity:jsonb:YES"
    ]);
    const pk = (await c.query("SELECT a.attname FROM pg_index i JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey) WHERE i.indrelid = 'crablet_model_snapshots'::regclass AND i.indisprimary ORDER BY array_position(i.indkey::int2[], a.attnum)")).rows.map((r) => r.attname);
    assert.deepStrictEqual(pk, ["name", "version", "fingerprint"]);
  });

  it("the first save inserts; a later cursor replaces; an equal or earlier one changes nothing", async () => {
    assert.strictEqual(await save("wallet", 1, "fp-a", "100", "10", { balance: 5 }), true);
    assert.deepStrictEqual(await row("wallet", 1, "fp-a"), { x: "100", p: "10", state: { balance: 5 } });
    assert.strictEqual(await save("wallet", 1, "fp-a", "200", "20", { balance: 9 }), true, "later transaction, later position");
    assert.strictEqual(await save("wallet", 1, "fp-a", "200", "20", { balance: 99 }), false, "the same cursor is not a write");
    assert.strictEqual(await save("wallet", 1, "fp-a", "150", "15", { balance: 7 }), false, "an earlier cursor (a slow writer) never moves it back");
    assert.deepStrictEqual(await row("wallet", 1, "fp-a"), { x: "200", p: "20", state: { balance: 9 } });
  });

  it("order is (transaction_id, position), not position alone: a higher position in a LOWER transaction is earlier", async () => {
    await save("wallet", 1, "fp-b", "300", "30", { n: 1 });
    assert.strictEqual(await save("wallet", 1, "fp-b", "250", "35", { n: 2 }), false);
    assert.strictEqual(await save("wallet", 1, "fp-b", "300", "31", { n: 3 }), true, "same transaction, higher position");
    assert.deepStrictEqual(await row("wallet", 1, "fp-b"), { x: "300", p: "31", state: { n: 3 } });
  });

  it("name, version and fingerprint each make a different snapshot", async () => {
    await save("m", 1, "fp", "10", "1", { v: "base" });
    assert.strictEqual(await save("m", 2, "fp", "10", "1", { v: "other version" }), true);
    assert.strictEqual(await save("m", 1, "fp2", "10", "1", { v: "other entity" }), true);
    assert.strictEqual(await save("n", 1, "fp", "10", "1", { v: "other model" }), true);
    assert.deepStrictEqual((await row("m", 1, "fp")).state, { v: "base" });
  });

  it("stores the entity with the row, and a later save replaces it; a six-argument call (no entity) still works", async () => {
    await c.query("SELECT crablet_save_snapshot('ent', 1, 'fp', '1'::xid8, 1, '{}'::jsonb, '{\"id\":\"a\"}'::jsonb)");
    assert.deepStrictEqual((await c.query("SELECT entity FROM crablet_model_snapshots WHERE name = 'ent'")).rows[0].entity, { id: "a" });
    await c.query("SELECT crablet_save_snapshot('ent', 1, 'fp', '2'::xid8, 2, '{}'::jsonb, '{\"id\":\"a\",\"year\":2026}'::jsonb)");
    assert.deepStrictEqual((await c.query("SELECT entity FROM crablet_model_snapshots WHERE name = 'ent'")).rows[0].entity, { id: "a", year: 2026 });
    await save("legacy", 1, "fp", "1", "1", {});
    assert.strictEqual((await c.query("SELECT entity FROM crablet_model_snapshots WHERE name = 'legacy'")).rows[0].entity, null);
  });

  it("rejects an empty or over-long name and a negative version", async () => {
    await assert.rejects(save("", 1, "fp", "1", "1", {}));
    await assert.rejects(save("x".repeat(65), 1, "fp", "1", "1", {}));
    await assert.rejects(save("ok", -1, "fp", "1", "1", {}));
  });
});
