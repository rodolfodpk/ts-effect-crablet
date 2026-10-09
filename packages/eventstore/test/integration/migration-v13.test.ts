// Runs under Node (Testcontainers). Migration V13 removes the nine secondary indexes V3 put on the progress tables, keeps the primary keys, and can be re-applied.
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Client } from "pg";
import { migrationFiles, sqlDir, startTestDb, type TestDb } from "@crablet/test-support";

const V13 = "V13__crablet_drop_progress_secondary_indexes.sql";
const TABLES = ["crablet_outbox_topic_progress", "crablet_view_progress", "crablet_automation_progress"];
let db: TestDb;
let client: Client;
before(async () => {
  assert.ok(migrationFiles.includes(V13), "V13 is a migration");
  db = await startTestDb({ migrations: migrationFiles.slice(0, migrationFiles.indexOf(V13)) });
  client = new Client({ host: db.connInfo.host, port: db.connInfo.port, database: db.connInfo.database, user: db.connInfo.username, password: db.connInfo.password });
  await client.connect();
}, { timeout: 60_000 });
after(async () => { await client.end(); await db.stop(); });

const indexNames = async () =>
  (await client.query("SELECT indexname FROM pg_indexes WHERE tablename = ANY($1) ORDER BY indexname", [TABLES])).rows.map((r) => r.indexname as string);

describe("migration V13: the progress tables keep only their primary keys", () => {
  it("drops the nine secondary indexes, keeps the keys, and is idempotent", { timeout: 60_000 }, async () => {
    const before13 = await indexNames();
    assert.strictEqual(before13.filter((n) => n.startsWith("idx_")).length, 9, "V3 left nine secondary indexes");

    await client.query(readFileSync(`${sqlDir}/${V13}`, "utf-8"));
    const after13 = await indexNames();
    assert.deepStrictEqual(after13.filter((n) => n.startsWith("idx_")), [], "no secondary index is left");
    assert.strictEqual(after13.length, before13.length - 9, "only those nine went; the primary keys stay");

    await client.query(readFileSync(`${sqlDir}/${V13}`, "utf-8"));
  });
});
