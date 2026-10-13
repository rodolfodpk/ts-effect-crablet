// Runs under Node (Testcontainers). Migration V14 drops the two scan-progress tables V3 created and nothing ever used, leaves the three progress tables that hold the
// pollers' cursors alone, and can be re-applied.
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Client } from "pg";
import { migrationFiles, sqlDir, startTestDb, type TestDb } from "@crablet/test-support";

const V14 = "V14__crablet_drop_unused_scan_progress.sql";
const UNUSED = ["crablet_module_scan_progress", "crablet_processor_scan_progress"];
const KEPT = ["crablet_outbox_topic_progress", "crablet_view_progress", "crablet_automation_progress"];
let db: TestDb;
let client: Client;
before(async () => {
  assert.ok(migrationFiles.includes(V14), "V14 is a migration");
  db = await startTestDb({ migrations: migrationFiles.slice(0, migrationFiles.indexOf(V14)) });
  client = new Client({ host: db.connInfo.host, port: db.connInfo.port, database: db.connInfo.database, user: db.connInfo.username, password: db.connInfo.password });
  await client.connect();
}, { timeout: 60_000 });
after(async () => { await client.end(); await db.stop(); });

const tables = async (names: ReadonlyArray<string>) =>
  (await client.query("SELECT tablename FROM pg_tables WHERE tablename = ANY($1) ORDER BY tablename", [names])).rows.map((r) => r.tablename as string);

describe("migration V14: the unused scan-progress tables are gone", () => {
  it("drops the two tables, keeps the three that hold the cursors, and is idempotent", { timeout: 60_000 }, async () => {
    assert.deepStrictEqual(await tables(UNUSED), [...UNUSED].sort(), "V3 created both");

    await client.query(readFileSync(`${sqlDir}/${V14}`, "utf-8"));
    assert.deepStrictEqual(await tables(UNUSED), [], "neither is left");
    assert.deepStrictEqual(await tables(KEPT), [...KEPT].sort(), "the cursors' tables stay");

    await client.query(readFileSync(`${sqlDir}/${V14}`, "utf-8"));
  });
});
