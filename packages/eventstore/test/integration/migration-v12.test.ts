// Runs under Node (Testcontainers). Migration V12 removes the snapshot table and function that V9 and V10 added (ADR-0018, superseded), on a database that has them
// and holds a snapshot row, and leaves everything else alone.
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Client } from "pg";
import { migrationFiles, sqlDir, startTestDb, type TestDb } from "@crablet/test-support";

const V12 = "V12__crablet_drop_model_snapshots.sql";
let db: TestDb;
let client: Client;
before(async () => {
  assert.ok(migrationFiles.includes(V12), "V12 is a migration");
  db = await startTestDb({ migrations: migrationFiles.slice(0, migrationFiles.indexOf(V12)) });
  client = new Client({ host: db.connInfo.host, port: db.connInfo.port, database: db.connInfo.database, user: db.connInfo.username, password: db.connInfo.password });
  await client.connect();
}, { timeout: 60_000 });
after(async () => { await client.end(); await db.stop(); });

describe("migration V12: the snapshot table and function are removed", () => {
  it("a database that had snapshots loses the table and the function, keeps its events and everything else, and a fresh database never has them to begin with", { timeout: 60_000 }, async () => {
    // a database as V11 leaves it: the table and function exist (V9, V10), with a row
    assert.notStrictEqual((await client.query("SELECT to_regclass('crablet_model_snapshots') AS t")).rows[0].t, null);
    await client.query("SELECT crablet_save_snapshot('m', 1, 'fp', '1'::xid8, 1, '{}'::jsonb, '{\"id\":\"a\"}'::jsonb)");
    await client.query("SELECT append_events_batch(ARRAY['E'], ARRAY['{\"k=v\"}'], ARRAY['{}'::jsonb], now(), NULL, NULL)");

    await client.query(readFileSync(`${sqlDir}/${V12}`, "utf-8"));

    assert.strictEqual((await client.query("SELECT to_regclass('crablet_model_snapshots') AS t")).rows[0].t, null, "the table is gone");
    assert.strictEqual((await client.query("SELECT count(*) AS n FROM pg_proc WHERE proname = 'crablet_save_snapshot'")).rows[0].n, "0", "the function is gone");
    assert.strictEqual((await client.query("SELECT count(*) AS n FROM crablet_events")).rows[0].n, "1", "the events are untouched");
    assert.strictEqual((await client.query("SELECT count(*) AS n FROM crablet_event_tag_keys")).rows[0].n, "1", "so is the tag-key table");
    await client.query("SELECT append_events_batch(ARRAY['E'], ARRAY['{\"k=v\"}'], ARRAY['{}'::jsonb], now(), NULL, NULL)"); // appends still work
  });

  it("it can be applied to a database that does not have them (idempotent)", async () => {
    await client.query(readFileSync(`${sqlDir}/${V12}`, "utf-8"));
  });
});
