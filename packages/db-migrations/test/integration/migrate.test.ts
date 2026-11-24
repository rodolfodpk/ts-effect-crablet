// Runs under Node (Testcontainers) - see docs/history/NOTES.md.
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "pg";
import { startTestDb, type TestDb } from "@crablet/test-support";
import { migrate, migrateApp, migrateIfFresh } from "../../src/Migrate.ts";

let db: TestDb;
before(async () => { db = await startTestDb({ migrations: [] }); }, { timeout: 60_000 });
after(async () => { await db.stop(); });

const query = async <T>(text: string, read: (rows: ReadonlyArray<Record<string, unknown>>) => T): Promise<T> => {
  const client = new Client({ host: db.connInfo.host, port: db.connInfo.port, database: db.connInfo.database, user: db.connInfo.username, password: db.connInfo.password });
  await client.connect();
  try {
    return read((await client.query(text)).rows);
  } finally {
    await client.end();
  }
};
const tables = () => query("SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY 1", (rows) => rows.map((r) => String(r["table_name"])));
const reset = () => query("DROP SCHEMA public CASCADE; CREATE SCHEMA public", () => undefined);

const appDir = mkdtempSync(path.join(tmpdir(), "crablet-app-migrations-"));
// The app's view reads the framework's log: it can only be created after the core schema.
writeFileSync(path.join(appDir, "V100__app_view.sql"), "CREATE TABLE app_view (position BIGINT PRIMARY KEY);");
writeFileSync(path.join(appDir, "V101__app_view_reads_the_log.sql"), "CREATE VIEW app_log AS SELECT position FROM crablet_events;");
writeFileSync(path.join(appDir, "V102__broken.sql"), "CREATE TABLE half_done (x INT); SELECT no_such_function();");
const app = { dir: appDir, files: ["V100__app_view.sql", "V101__app_view_reads_the_log.sql"] };

describe("migrate and migrateIfFresh", () => {
  it("apply the framework's schema, then the application's, to an empty database; a second start leaves it alone", async () => {
    await reset();
    assert.strictEqual(await migrateIfFresh(db.connInfo, app), "applied");
    const applied = await tables();
    for (const t of ["crablet_events", "crablet_view_progress", "app_view", "app_log"]) assert.ok(applied.includes(t), `${t} in ${applied}`);
    assert.strictEqual(await migrateIfFresh(db.connInfo, app), "present", "the second start does not apply them again");
    assert.deepStrictEqual(await tables(), applied);
  });

  it("apply everything in one transaction: a failing file leaves the database as it was, so the next start applies it all", async () => {
    await reset();
    await assert.rejects(migrate(db.connInfo, { dir: appDir, files: [...app.files, "V102__broken.sql"] }), /no_such_function/);
    assert.deepStrictEqual(await tables(), [], "nothing of the framework's or the application's was left");
    assert.strictEqual(await migrateIfFresh(db.connInfo, app), "applied");
  });

  it("with no application set, apply the framework's schema only", async () => {
    await reset();
    await migrate(db.connInfo);
    const applied = await tables();
    assert.ok(applied.includes("crablet_events"));
    assert.ok(!applied.includes("app_view"));
  });

  it("migrateApp applies the application's set alone, on top of the framework's schema", async () => {
    await reset();
    await migrate(db.connInfo);
    await migrateApp(db.connInfo, app);
    assert.ok((await tables()).includes("app_log"));
  });
});
