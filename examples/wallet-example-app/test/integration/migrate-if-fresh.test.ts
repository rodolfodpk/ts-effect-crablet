// Runs under Node (Testcontainers) - see NOTES.md. The entry point applies the schema to a fresh database only, so the app can restart against the same database.
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { Client } from "pg";
import { startTestDb, type TestDb } from "@crablet/test-support";
import { migrateIfFresh } from "../../src/migrate.ts";

let db: TestDb;
before(async () => { db = await startTestDb({ migrations: [] }); }, { timeout: 60_000 });
after(async () => { await db.stop(); });

const tables = async (): Promise<ReadonlyArray<string>> => {
  const client = new Client({ host: db.connInfo.host, port: db.connInfo.port, database: db.connInfo.database, user: db.connInfo.username, password: db.connInfo.password });
  await client.connect();
  try {
    return (await client.query("SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY 1")).rows.map((r) => r.table_name as string);
  } finally {
    await client.end();
  }
};

describe("migrateIfFresh", () => {
  it("applies the framework's schema and the wallet's own to an empty database, and leaves a database that has it alone (a restart)", async () => {
    assert.deepStrictEqual(await tables(), []);
    assert.strictEqual(await migrateIfFresh(db.connInfo), "applied");
    const after = await tables();
    for (const t of ["crablet_events", "crablet_view_progress", "wallet_balance_view"]) assert.ok(after.includes(t), `${t} in ${after}`);
    assert.strictEqual(await migrateIfFresh(db.connInfo), "present", "the second start does not try to apply them again");
    assert.deepStrictEqual(await tables(), after);
  });
});
