// Runs under Node (Testcontainers) - see NOTES.md.
// V8 backfills the transaction id half of every progress cursor with crablet_progress_cursor_xid(last_position):
// the smaller of the xid at last_position and the smallest xid among LATER events, so an event the old
// position cursor had not delivered yet (a lower xid, a higher position) is never put behind the new cursor.
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { Client } from "pg";
import { startTestDb, type TestDb } from "@crablet/test-support";

let db: TestDb;
let client: Client;

before(async () => {
  db = await startTestDb();
  client = new Client({
    host: db.connInfo.host,
    port: db.connInfo.port,
    database: db.connInfo.database,
    user: db.connInfo.username,
    password: db.connInfo.password
  });
  await client.connect();
}, { timeout: 60_000 });

after(async () => {
  await client.end();
  await db.stop();
});

const insert = async (position: number, xid: number) =>
  client.query(
    `INSERT INTO crablet_events (position, type, tags, data, transaction_id)
     VALUES ($1, 'BackfillEvent', ARRAY[]::text[], '{}'::jsonb, $2::xid8)`,
    [position, xid]
  );
const xidFor = async (lastPosition: number) =>
  (await client.query("SELECT crablet_progress_cursor_xid($1)::text AS x", [lastPosition])).rows[0].x as string;

describe("V8 progress cursor backfill", () => {
  it("a row that never ran gets xid 0", async () => {
    assert.equal(await xidFor(0), "0");
  });

  it("the ordinary case: the xid of the event at last_position", async () => {
    await insert(1, 100);
    await insert(2, 101);
    assert.equal(await xidFor(1), "100");
  });

  it("an undelivered event with a LOWER xid but a HIGHER position pulls the xid down, so it is still delivered", async () => {
    // position 5 has xid 200 (delivered); position 6 has xid 150 (not yet delivered under the old cursor)
    await insert(5, 200);
    await insert(6, 150);
    assert.equal(await xidFor(5), "150");
  });

  it("when the event at last_position is gone and nothing is newer, the newest xid is used (everything left was processed)", async () => {
    assert.equal(await xidFor(50), "200");
  });
});
