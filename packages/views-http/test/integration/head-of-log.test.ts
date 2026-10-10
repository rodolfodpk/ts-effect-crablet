// Runs under Node (Testcontainers) - see NOTES.md. `headOfLog` is "everything committed when this was asked", in the (transaction_id, position) order every cursor uses (ADR-0012). It is now the
// fallback of the consistent read (the default path takes the head and the views' progress in one statement), but the consistency wrapper still uses it when it is given no `check`, and its query has
// a trap of its own: an ORDER BY name resolves to an output column first, so selecting the transaction id as text under its own name would sort it as TEXT, and "999" would come after "1000".
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { Effect, Layer, ManagedRuntime, Redacted } from "effect";
import { PgClient } from "@effect/sql-pg";
import { Client } from "pg";
import { startTestDb, type TestDb } from "@crablet/test-support";
import { EventStore, EventStoreLive } from "@crablet/eventstore";
import * as AppendEvent from "@crablet/eventstore/AppendEvent";
import * as ProgressCursor from "@crablet/event-poller/ProgressCursor";
import { headOfLog } from "../../src/HeadOfLog.ts";

let db: TestDb;
let runtime: ManagedRuntime.ManagedRuntime<EventStore | PgClient.PgClient, never>;
let probe: Client;
before(async () => {
  db = await startTestDb();
  runtime = ManagedRuntime.make(
    Layer.provideMerge(
      EventStoreLive,
      PgClient.layer({ host: db.connInfo.host, port: db.connInfo.port, database: db.connInfo.database, username: db.connInfo.username, password: Redacted.make(db.connInfo.password) })
    ) as never
  );
  probe = new Client({ host: db.connInfo.host, port: db.connInfo.port, database: db.connInfo.database, user: db.connInfo.username, password: db.connInfo.password });
  await probe.connect();
}, { timeout: 60_000 });
after(async () => { await probe.end(); await runtime.dispose(); await db.stop(); });

const head = () => runtime.runPromise(headOfLog as never) as Promise<ProgressCursor.ProgressCursor>;
const appendOne = async (type: string) => {
  const result = await runtime.runPromise(Effect.flatMap(EventStore, (es) => es.append([AppendEvent.builder(type).tag("k", "v").data({}).build()])) as never);
  const r = result as { lastPosition: bigint; transactionId: string };
  return ProgressCursor.of(r.transactionId, r.lastPosition);
};
// Uses up transaction ids (each autocommit statement that asks for one takes one) until their text is one digit longer.
const burnUntilLonger = async () => {
  const digits = (await probe.query<{ x: string }>("SELECT pg_current_xact_id()::text AS x")).rows[0]!.x.length;
  for (let i = 0; i < 50_000; i++) {
    if ((await probe.query<{ x: string }>("SELECT pg_current_xact_id()::text AS x")).rows[0]!.x.length > digits) return;
  }
  throw new Error("could not cross a digit boundary of the transaction id");
};

describe("headOfLog", () => {
  it("an empty log is the zero cursor, which every view has already reached", async () => {
    assert.deepStrictEqual(await head(), ProgressCursor.zero);
  });

  it("is the cursor of the newest committed event", async () => {
    await appendOne("HeadA");
    const last = await appendOne("HeadB");
    assert.deepStrictEqual(await head(), last);
  });

  it("orders transaction ids as NUMBERS: the head after the ids gain a digit is the newer one, not the one that sorts last as text", async () => {
    const before = await appendOne("HeadBefore"); // e.g. transaction id "999"
    await burnUntilLonger(); // now ids have one more digit: "1000..."
    const after = await appendOne("HeadAfter");
    assert.ok(after.transactionId.length > before.transactionId.length, "the second append has a longer transaction id");
    assert.deepStrictEqual(await head(), after, "text order would put '999' after '1000'");
  });
});
