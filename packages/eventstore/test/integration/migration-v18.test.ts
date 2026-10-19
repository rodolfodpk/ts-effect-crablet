// Runs under Node (Testcontainers). Migration V18 (ADR-0036) gives every event a stable public id: existing events get one when it is applied, new events
// get one from the column's default, and the event store and the pollers read the same id for the same event.
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Client } from "pg";
import { migrationFiles, sqlDir, startTestDb, type TestDb } from "@crablet/test-support";

const V18 = "V18__crablet_event_id.sql";
const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
let db: TestDb;
let client: Client;
const query = async <T extends Record<string, unknown>>(text: string, params: ReadonlyArray<unknown> = []) => (await client.query(text, params as never[])).rows as T[];
const append = (type: string) => client.query("SELECT append_events_batch(ARRAY[$1], ARRAY['{k=v}'], ARRAY['{}'::jsonb], now())", [type]);

before(async () => {
  assert.ok(migrationFiles.includes(V18), "V18 is a migration");
  db = await startTestDb({ migrations: migrationFiles.slice(0, migrationFiles.indexOf(V18)) });
  client = new Client({ host: db.connInfo.host, port: db.connInfo.port, database: db.connInfo.database, user: db.connInfo.username, password: db.connInfo.password });
  await client.connect();
}, { timeout: 60_000 });
after(async () => { await client.end(); await db.stop(); });

describe("migration V18: every event has a stable public id", () => {
  it("existing events get distinct uuidv7 ids, new ones get them on insert, and an id never changes", { timeout: 60_000 }, async () => {
    for (let i = 0; i < 5; i++) await append("Before");
    await client.query(readFileSync(`${sqlDir}/${V18}`, "utf-8"));
    await append("After");

    const rows = await query<{ type: string; event_id: string }>("SELECT type, event_id::text AS event_id FROM crablet_events ORDER BY position");
    assert.deepEqual(rows.map((r) => r.type), ["Before", "Before", "Before", "Before", "Before", "After"]);
    assert.ok(rows.every((r) => UUID_V7.test(r.event_id)), `uuidv7 ids: ${rows.map((r) => r.event_id).join(", ")}`);
    assert.equal(new Set(rows.map((r) => r.event_id)).size, rows.length, "distinct");

    const again = await query<{ event_id: string }>("SELECT event_id::text AS event_id FROM crablet_events ORDER BY position");
    assert.deepEqual(again.map((r) => r.event_id), rows.map((r) => r.event_id), "read twice, the same ids");
  });
});
