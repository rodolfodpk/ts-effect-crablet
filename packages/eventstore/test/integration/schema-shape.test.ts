// Runs under Node (Testcontainers). What the schema must be, beyond what the snapshot records: the properties the decisions rely on, each with its reason.
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { Client } from "pg";
import { startTestDb, type TestDb } from "@crablet/test-support";

const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
let db: TestDb;
let client: Client;
before(async () => {
  db = await startTestDb();
  client = new Client({ host: db.connInfo.host, port: db.connInfo.port, database: db.connInfo.database, user: db.connInfo.username, password: db.connInfo.password });
  await client.connect();
}, { timeout: 60_000 });
after(async () => { await client.end(); await db.stop(); });

const query = async <T extends Record<string, unknown>>(text: string, params: ReadonlyArray<unknown> = []) => (await client.query(text, params as never[])).rows as T[];
const append = (type: string, tags: ReadonlyArray<string>) =>
  client.query("SELECT append_events_batch(ARRAY[$1], ARRAY[$2], ARRAY['{}'::jsonb], now(), NULL, NULL)", [type, `{${tags.map((t) => `"${t}"`).join(",")}}`]);

describe("the schema", () => {
  it("crablet_event_tag_keys is (key, position) with a primary key on them, no other index and no foreign key (ADR-0019)", async () => {
    const cols = (await query<{ column_name: string; data_type: string }>("SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 'crablet_event_tag_keys' ORDER BY ordinal_position")).map((c) => `${c.column_name}:${c.data_type}`);
    assert.deepStrictEqual(cols, ["key:text", "position:bigint"]);
    const indexes = (await query<{ indexdef: string }>("SELECT indexdef FROM pg_indexes WHERE tablename = 'crablet_event_tag_keys'")).map((i) => i.indexdef);
    assert.strictEqual(indexes.length, 1);
    assert.match(indexes[0]!, /\(key, "?position"?\)/);
    assert.strictEqual((await query("SELECT 1 FROM pg_constraint WHERE conrelid = 'crablet_event_tag_keys'::regclass AND contype = 'f'")).length, 0);
  });

  it("an append writes one (key, position) row per distinct tag key: a list-valued tag once, a tag without '=' not at all", async () => {
    await append("List", ["product_id=p1", "product_id=p2", "order_id=o1"]);
    await append("Odd", ["empty=", "has_eq=a=b", "k=v"]);
    const pairs = (await query<{ key: string }>("SELECT key FROM crablet_event_tag_keys ORDER BY position, key")).map((r) => r.key);
    assert.deepStrictEqual(pairs, ["order_id", "product_id", "empty", "has_eq", "k"]);
  });

  it("the progress tables have only their primary keys: they are read by key, and an index would block HOT updates of every tick", async () => {
    const tables = ["crablet_outbox_topic_progress", "crablet_view_progress", "crablet_automation_progress", "crablet_deadline_progress"];
    const indexes = (await query<{ indexname: string }>("SELECT indexname FROM pg_indexes WHERE tablename = ANY($1) ORDER BY indexname", [tables])).map((r) => r.indexname);
    assert.deepStrictEqual(indexes.filter((n) => !n.endsWith("_pkey") && !n.startsWith("pk_")), []);
    assert.strictEqual(indexes.length, tables.length, "one primary key each");
  });

  it("every event gets a distinct uuidv7 id on insert, and it never changes (ADR-0036)", async () => {
    for (let i = 0; i < 3; i++) await append("Ided", []);
    const rows = await query<{ event_id: string }>("SELECT event_id::text AS event_id FROM crablet_events WHERE type = 'Ided' ORDER BY position");
    assert.ok(rows.every((r) => UUID_V7.test(r.event_id)), `uuidv7 ids: ${rows.map((r) => r.event_id).join(", ")}`);
    assert.equal(new Set(rows.map((r) => r.event_id)).size, rows.length, "distinct");
    const again = await query<{ event_id: string }>("SELECT event_id::text AS event_id FROM crablet_events WHERE type = 'Ided' ORDER BY position");
    assert.deepEqual(again, rows, "read twice, the same ids");
  });

  it("holds only the framework's tables and functions: nothing a past design left behind", async () => {
    const tables = (await query<{ tablename: string }>("SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename")).map((r) => r.tablename);
    assert.deepStrictEqual(tables, [
      "crablet_automation_progress", "crablet_commands", "crablet_deadline_progress", "crablet_deadlines", "crablet_event_tag_keys", "crablet_events",
      "crablet_outbox_topic_progress", "crablet_view_progress"
    ]);
  });
});
