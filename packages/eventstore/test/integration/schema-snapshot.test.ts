// Runs under Node (Testcontainers). The migrations give the schema in packages/db-migrations/schema-snapshot.json, read from the catalog (ADR-0047): every
// table, column, constraint, index, function body and comment. A change to the schema shows here as a diff to review. When the change is meant,
// UPDATE_SCHEMA_SNAPSHOT=1 rewrites the snapshot; commit it with the migration.
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import { startTestDb, type TestDb } from "@crablet/test-support";
import { catalogDump } from "@crablet/test-support/CatalogDump";

const SNAPSHOT = fileURLToPath(new URL("../../../db-migrations/schema-snapshot.json", import.meta.url));
let db: TestDb;
let client: Client;
before(async () => {
  db = await startTestDb();
  client = new Client({ host: db.connInfo.host, port: db.connInfo.port, database: db.connInfo.database, user: db.connInfo.username, password: db.connInfo.password });
  await client.connect();
}, { timeout: 60_000 });
after(async () => { await client.end(); await db.stop(); });

describe("the schema the migrations give", () => {
  it("is the committed snapshot", async () => {
    const actual = JSON.stringify(await catalogDump(client), null, 2) + "\n";
    if (process.env["UPDATE_SCHEMA_SNAPSHOT"] === "1") writeFileSync(SNAPSHOT, actual);
    assert.strictEqual(actual, readFileSync(SNAPSHOT, "utf8"), "the schema differs from packages/db-migrations/schema-snapshot.json (UPDATE_SCHEMA_SNAPSHOT=1 rewrites it; review the diff)");
  });
});
