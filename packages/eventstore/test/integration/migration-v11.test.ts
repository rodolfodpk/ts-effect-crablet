// Runs under Node (Testcontainers). Migration V11 (ADR-0019) on a database that already holds data: the database is migrated up to V10, filled through the V10
// append function (so the OLD tag table is populated the way production data was), then V11 is applied.
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Client } from "pg";
import { migrationFiles, sqlDir, startTestDb, type TestDb } from "@crablet/test-support";

const V11 = "V11__crablet_slim_event_tag_keys.sql";
let db: TestDb;
let client: Client;
const connect = async () => {
  const c = new Client({ host: db.connInfo.host, port: db.connInfo.port, database: db.connInfo.database, user: db.connInfo.username, password: db.connInfo.password });
  await c.connect();
  return c;
};
const query = async <T extends Record<string, unknown>>(text: string, params: ReadonlyArray<unknown> = []) => (await client.query(text, params as never[])).rows as T[];
const appendOn = (c: Client, type: string, tags: ReadonlyArray<string>) =>
  c.query("SELECT append_events_batch(ARRAY[$1], ARRAY[$2], ARRAY['{}'::jsonb], now(), NULL, NULL)", [type, `{${tags.map((t) => `"${t}"`).join(",")}}`]);
const append = (type: string, tags: ReadonlyArray<string>) => appendOn(client, type, tags);

before(async () => {
  assert.ok(migrationFiles.at(-1) === V11, "V11 is the last migration (update this test when another is added after it)");
  db = await startTestDb({ migrations: migrationFiles.slice(0, -1) });
  client = await connect();
}, { timeout: 60_000 });
after(async () => { await client.end(); await db.stop(); });

describe("migration V11: crablet_event_tags becomes crablet_event_tag_keys", () => {
  it("keeps what the pollers ask of it: the same (key, position) pairs, once each, from a populated V10 database; drops the old table; appends go on, with list-valued tags", { timeout: 120_000 }, async () => {
    // before: events through the V10 function, including an event that carries the same key twice, empty values, a value containing '=', and many plain events
    for (let i = 0; i < 400; i++) await append(i % 3 === 0 ? "A" : "B", [`wallet_id=w${i % 20}`, `deposit_id=d${i}`, ...(i % 50 === 0 ? ["audit_id=a"] : [])]);
    await append("List", ["product_id=p1", "product_id=p2", "order_id=o1"]);
    await append("Odd", ["empty=", "has_eq=a=b", "k=v"]);
    // a tag with no '=' cannot come from the framework's append path, but the column allows it: it must be ignored, as the old table ignored it
    await client.query("INSERT INTO crablet_events (type, tags, data, transaction_id) VALUES ('Raw', ARRAY['novalue', 'k=v'], '{}'::jsonb, pg_current_xact_id())");
    const oldPairs = (await query<{ key: string; position: string }>("SELECT DISTINCT key, position::text AS position FROM crablet_event_tags ORDER BY key, position")).map((r) => `${r.key}:${r.position}`);
    const oldRows = Number((await query<{ n: string }>("SELECT count(*) AS n FROM crablet_event_tags"))[0]!.n);
    assert.ok(oldPairs.length > 800 && oldRows >= oldPairs.length, `old table: ${oldRows} rows, ${oldPairs.length} distinct pairs`);

    await client.query(readFileSync(`${sqlDir}/${V11}`, "utf-8"));

    assert.strictEqual((await query("SELECT to_regclass('crablet_event_tags') AS t"))[0]!.t, null, "the old table is gone");
    const newPairs = (await query<{ key: string; position: string }>("SELECT key, position::text AS position FROM crablet_event_tag_keys ORDER BY key, position")).map((r) => `${r.key}:${r.position}`);
    const onlyNew = newPairs.filter((p) => !oldPairs.includes(p));
    const onlyOld = oldPairs.filter((p) => !newPairs.includes(p));
    assert.deepStrictEqual(onlyOld, [], "nothing the old table held is lost");
    // the ONE difference is the raw insert that bypassed the append function (so the old table never had its row): the backfill reads the events' own tags, the
    // source of truth, so it picks that pair up; and the tag without '=' on the same event is still ignored
    assert.deepStrictEqual(onlyNew.map((p) => p.split(":")[0]), ["k"], `only the raw event's k=v is new: ${onlyNew}`);
    assert.ok(!newPairs.some((p) => p.startsWith("novalue:")), "a tag without '=' is not a key");
    assert.strictEqual(newPairs.length, new Set(newPairs).size, "each pair once");

    // after: the new function keeps it current, and a list-valued tag does not trip the primary key
    const rowsBefore = newPairs.length;
    await append("List", ["product_id=p7", "product_id=p8", "product_id=p9"]);
    await append("A", ["wallet_id=w1", "deposit_id=dx"]);
    const rowsAfter = Number((await query<{ n: string }>("SELECT count(*) AS n FROM crablet_event_tag_keys"))[0]!.n);
    assert.strictEqual(rowsAfter, rowsBefore + 1 + 2, "one pair for product_id (three values), two for the other event");
  });

  it("the shape is what the ADR says: (key, position), a primary key on them, no other index, no foreign key", async () => {
    const cols = (await query<{ column_name: string; data_type: string }>("SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 'crablet_event_tag_keys' ORDER BY ordinal_position")).map((c) => `${c.column_name}:${c.data_type}`);
    assert.deepStrictEqual(cols, ["key:text", "position:bigint"]);
    const indexes = (await query<{ indexdef: string }>("SELECT indexdef FROM pg_indexes WHERE tablename = 'crablet_event_tag_keys'")).map((i) => i.indexdef);
    assert.strictEqual(indexes.length, 1);
    assert.match(indexes[0]!, /\(key, "?position"?\)/);
    assert.strictEqual((await query("SELECT 1 FROM pg_constraint WHERE conrelid = 'crablet_event_tag_keys'::regclass AND contype = 'f'")).length, 0);
  });

  it("the migration text pauses writers (SHARE ROW EXCLUSIVE on the events table), and that lock really does hold a second writer back", async () => {
    assert.match(readFileSync(`${sqlDir}/${V11}`, "utf-8"), /LOCK TABLE crablet_events IN SHARE ROW EXCLUSIVE MODE/);
    const other = await connect();
    try {
      await client.query("BEGIN");
      await client.query("LOCK TABLE crablet_events IN SHARE ROW EXCLUSIVE MODE");
      await other.query("SET lock_timeout = '300ms'");
      await assert.rejects(appendOn(other, "Z", ["k=v"]), /lock timeout/);
      await client.query("ROLLBACK");
      await other.query("SET lock_timeout = 0");
      await appendOn(other, "Z", ["k=v"]); // free again
    } finally {
      await client.query("ROLLBACK").catch(() => {});
      await other.end();
    }
  });
});
