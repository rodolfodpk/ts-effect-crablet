// Runs under Node (Testcontainers) - see docs/history/NOTES.md. `settleViews` against Postgres, through its interface: the end of the log, a marker beyond it, and the outcome for
// views that are caught up, behind or FAILED. The rules between the looks are unit-tested (settle-views.test.ts); here the real looks are behind them.
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { Effect, Layer, ManagedRuntime, Redacted } from "effect";
import { SqlClient } from "effect/sql";
import { PgClient } from "@effect/sql-pg";
import { Client } from "pg";
import { startTestDb, type TestDb } from "@crablet/test-support";
import { EventStore, EventStoreLive } from "@crablet/eventstore";
import * as AppendEvent from "@crablet/eventstore/AppendEvent";
import * as ProgressCursor from "@crablet/event-poller/ProgressCursor";
import { viewSubscriptionOf } from "../../src/ViewSubscription.ts";
import { settleViews, type Settlement } from "../../src/SettleViews.ts";

let db: TestDb;
let runtime: ManagedRuntime.ManagedRuntime<EventStore | SqlClient.SqlClient | PgClient.PgClient, never>;
let probe: Client;

before(async () => {
  db = await startTestDb();
  const pgLayer = PgClient.layer({ host: db.connInfo.host, port: db.connInfo.port, database: db.connInfo.database, username: db.connInfo.username, password: Redacted.make(db.connInfo.password) });
  runtime = ManagedRuntime.make(Layer.provideMerge(EventStoreLive, pgLayer) as unknown as Layer.Layer<EventStore | SqlClient.SqlClient | PgClient.PgClient, never>);
  probe = new Client({ host: db.connInfo.host, port: db.connInfo.port, database: db.connInfo.database, user: db.connInfo.username, password: db.connInfo.password });
  await probe.connect();
}, { timeout: 60_000 });
after(async () => {
  await probe.end();
  await runtime.dispose();
  await db.stop();
});

const run = <A, E>(effect: Effect.Effect<A, E, EventStore | SqlClient.SqlClient | PgClient.PgClient>) => runtime.runPromise(effect);
const settle = (...args: Parameters<typeof settleViews>): Promise<Settlement> => run(settleViews(...args));
const caughtUp: Settlement = { _tag: "Settled", outcome: { _tag: "CaughtUp" } };

const appendOne = async (type: string) => {
  const result = await run(Effect.flatMap(EventStore, (es) => es.append([AppendEvent.builder(type).tag("k", "v").data({}).build()])));
  return ProgressCursor.of(result.transactionId, result.lastPosition);
};
const setProgress = (view: string, cursor: ProgressCursor.ProgressCursor, status: string) =>
  run(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql.unsafe("DELETE FROM crablet_view_progress WHERE view_name = $1", [view]);
      yield* sql.unsafe("INSERT INTO crablet_view_progress (view_name, status, last_position, last_transaction_id) VALUES ($1, $2, $3::bigint, $4::xid8)", [view, status, cursor.position.toString(), cursor.transactionId]);
    })
  );
// Uses up transaction ids (each autocommit statement that asks for one takes one) until their text is one digit longer.
const burnUntilLonger = async () => {
  const digits = (await probe.query<{ x: string }>("SELECT pg_current_xact_id()::text AS x")).rows[0]!.x.length;
  for (let i = 0; i < 50_000; i++) {
    if ((await probe.query<{ x: string }>("SELECT pg_current_xact_id()::text AS x")).rows[0]!.x.length > digits) return;
  }
  throw new Error("could not cross a digit boundary of the transaction id");
};

describe("settleViews", () => {
  it("an empty log: every view has caught up, even one with no progress row, and any marker is beyond the end", async () => {
    assert.deepStrictEqual(await settle([viewSubscriptionOf("never-ran", { eventTypes: new Set(["Settle"]) })], null, 100), caughtUp);
    assert.deepStrictEqual(await settle([], ProgressCursor.of("1", 1n), 100), { _tag: "Beyond", head: ProgressCursor.zero });
  });

  it("a marker past the newest event is beyond the end of the log; the newest event itself is not", async () => {
    const last = await appendOne("SettleHead");
    assert.deepStrictEqual(await settle([], last, 100), caughtUp);
    assert.deepStrictEqual(await settle([], ProgressCursor.of(last.transactionId, last.position + 1n), 100), { _tag: "Beyond", head: last });
  });

  it("orders transaction ids as NUMBERS: after the ids gain a digit, the newest event is still not beyond the end (text order would put '999' after '1000')", async () => {
    const before = await appendOne("SettleBefore");
    await burnUntilLonger();
    const after = await appendOne("SettleAfter");
    assert.ok(after.transactionId.length > before.transactionId.length, "the second append has a longer transaction id");
    assert.deepStrictEqual(await settle([], after, 100), caughtUp);
  });

  it("names the views that have not caught up, in the order given: one behind is lagging (with how far it got), one FAILED is view_failed", async () => {
    const start = await appendOne("SettleOther");
    const write = await appendOne("SettleHandled");
    const handles = (name: string) => viewSubscriptionOf(name, { eventTypes: new Set(["SettleHandled"]) });
    await setProgress("settle-at", write, "ACTIVE");
    await setProgress("settle-behind", start, "ACTIVE");
    await setProgress("settle-failed", start, "FAILED");
    // behind the write, but nothing it handles is in between: caught up
    await setProgress("settle-ignores", start, "ACTIVE");
    const ignores = viewSubscriptionOf("settle-ignores", { eventTypes: new Set(["SomethingElse"]) });

    assert.deepStrictEqual(await settle([handles("settle-at"), ignores], write, 100), caughtUp);
    assert.deepStrictEqual(await settle([handles("settle-behind"), handles("settle-at"), handles("settle-failed")], write, 100), {
      _tag: "Settled",
      outcome: {
        _tag: "NotCaughtUp",
        reason: "view_failed",
        views: [
          { name: "settle-behind", reason: "lagging", reachedPosition: String(start.position) },
          { name: "settle-failed", reason: "view_failed", reachedPosition: null }
        ]
      }
    });
  });
});
