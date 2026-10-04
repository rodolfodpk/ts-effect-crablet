// Runs under Node (Testcontainers) - see NOTES.md. The wallet's transaction list pages by keyset, not OFFSET: rows that
// appear (or share a timestamp) while a client is paging must never be repeated or skipped. The tests write rows straight
// into the view table, so they control timestamps and ties exactly; the HTTP route, the SQL and the cursor are the real ones.
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { Effect, Layer, ManagedRuntime, Redacted } from "effect";
import { SqlClient } from "effect/sql";
import { PgClient } from "@effect/sql-pg";
import { EventStoreLive } from "@crablet/eventstore";
import { CommandAuditStoreLive } from "@crablet/eventstore/CommandAuditStore";
import { CommandExecutorLive } from "@crablet/commands";
import { startTestDb, type TestDb } from "@crablet/test-support";
import { startWalletAppForTest, type CoreServices, type RunningWalletApp } from "../support/startWalletAppForTest.ts";
import { applyAppMigrations } from "../support/applyAppMigrations.ts";

let db: TestDb;
let runtime: ManagedRuntime.ManagedRuntime<CoreServices, never>;
let app: RunningWalletApp;

before(async () => {
  db = await startTestDb();
  await applyAppMigrations(db.connInfo);
  const pgLayer = PgClient.layer({
    host: db.connInfo.host,
    port: db.connInfo.port,
    database: db.connInfo.database,
    username: db.connInfo.username,
    password: Redacted.make(db.connInfo.password)
  });
  const coreLayers = Layer.mergeAll(CommandExecutorLive, EventStoreLive, CommandAuditStoreLive);
  const layer = Layer.provideMerge(coreLayers, pgLayer) as unknown as Layer.Layer<CoreServices, never>;
  runtime = ManagedRuntime.make(layer);
  app = await startWalletAppForTest(runtime);
}, { timeout: 60_000 });

after(async () => {
  await app.stop();
  await runtime.dispose();
  await db.stop();
});

interface Row {
  readonly transactionId: string;
  readonly occurredAt: string; // any text Postgres reads as a timestamptz, microseconds included
  readonly eventPosition: number;
}

// The view's key is (transaction_id, event_position) across ALL wallets, so ids are namespaced by wallet (the prefix is the same for every
// row of one wallet, so the order of ids within a wallet is the order of the unprefixed ids) and stripped again when read back.
const insertRows = (walletId: string, rows: ReadonlyArray<Row>) =>
  runtime.runPromise(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      for (const row of rows) {
        yield* sql.unsafe(
          `INSERT INTO wallet_transaction_view (transaction_id, wallet_id, event_type, amount, description, occurred_at, event_position)
           VALUES ($1, $2, 'DepositMade', 1, 'test', $3::timestamptz, $4)`,
          [`${walletId}|${row.transactionId}`, walletId, row.occurredAt, row.eventPosition]
        );
      }
    })
  );

interface Page {
  readonly status: number;
  readonly body: { readonly transactions?: ReadonlyArray<{ readonly transactionId: string }>; readonly next?: string | null; readonly detail?: string };
}

const getPage = async (walletId: string, query: Record<string, string> = {}): Promise<Page> => {
  const qs = new URLSearchParams(query).toString();
  const res = await fetch(`${app.baseUrl}/api/wallets/${walletId}/transactions${qs === "" ? "" : `?${qs}`}`);
  const body = (await res.json()) as Page["body"];
  const strip = (id: string) => id.slice(id.indexOf("|") + 1);
  return { status: res.status, body: body.transactions === undefined ? body : { ...body, transactions: body.transactions.map((t) => ({ ...t, transactionId: strip(t.transactionId) })) } };
};

const idsOf = (page: Page) => (page.body.transactions ?? []).map((t) => t.transactionId);

// Follow `next` to the end, returning every id in the order served.
const readAll = async (walletId: string, limit: number): Promise<ReadonlyArray<string>> => {
  const served: Array<string> = [];
  let after: string | null = null;
  for (let guard = 0; guard < 50; guard++) {
    const page = await getPage(walletId, { limit: String(limit), ...(after === null ? {} : { after }) });
    assert.strictEqual(page.status, 200);
    served.push(...idsOf(page));
    after = page.body.next ?? null;
    if (after === null) return served;
  }
  throw new Error("paging did not end");
};

const walletId = () => `wallet-${crypto.randomUUID()}`;

describe("GET /api/wallets/:walletId/transactions (keyset pagination, real Postgres)", () => {
  it("serves newest first and pages with `next`, each row once, ending with next = null", async () => {
    const w = walletId();
    await insertRows(w, [1, 2, 3, 4, 5].map((n) => ({ transactionId: `t${n}`, occurredAt: `2026-10-03 12:00:0${n}+00`, eventPosition: n })));

    const first = await getPage(w, { limit: "2" });
    assert.deepStrictEqual(idsOf(first), ["t5", "t4"]);
    assert.ok(typeof first.body.next === "string");

    assert.deepStrictEqual(await readAll(w, 2), ["t5", "t4", "t3", "t2", "t1"]);
    assert.deepStrictEqual(await readAll(w, 5), ["t5", "t4", "t3", "t2", "t1"]); // exactly one full page: no phantom next page
    const last = await getPage(w, { limit: "5" });
    assert.strictEqual(last.body.next, null);
  });

  it("orders rows that share a timestamp by event position, then by id, without repeating or skipping any", async () => {
    const w = walletId();
    const at = "2026-10-03 12:00:00+00";
    await insertRows(w, [
      { transactionId: "a", occurredAt: at, eventPosition: 10 },
      { transactionId: "b", occurredAt: at, eventPosition: 10 }, // same event, same instant: only the id tells them apart
      { transactionId: "c", occurredAt: at, eventPosition: 11 },
      { transactionId: "d", occurredAt: at, eventPosition: 9 }
    ]);
    assert.deepStrictEqual(await readAll(w, 1), ["c", "b", "a", "d"]);
    assert.deepStrictEqual(await readAll(w, 3), ["c", "b", "a", "d"]);
  });

  it("tells apart rows a microsecond apart (the cursor keeps Postgres's precision, not JavaScript's milliseconds)", async () => {
    const w = walletId();
    await insertRows(w, [
      { transactionId: "early", occurredAt: "2026-10-03 12:00:00.123456+00", eventPosition: 1 },
      { transactionId: "late", occurredAt: "2026-10-03 12:00:00.123457+00", eventPosition: 1 },
      { transactionId: "latest", occurredAt: "2026-10-03 12:00:00.123458+00", eventPosition: 1 }
    ]);
    assert.deepStrictEqual(await readAll(w, 1), ["latest", "late", "early"]);
  });

  it("is not disturbed by rows added while a client is paging (the case OFFSET got wrong)", async () => {
    const w = walletId();
    await insertRows(w, [1, 2, 3, 4, 5, 6].map((n) => ({ transactionId: `t${n}`, occurredAt: `2026-10-03 12:00:0${n}+00`, eventPosition: n })));

    const first = await getPage(w, { limit: "3" });
    assert.deepStrictEqual(idsOf(first), ["t6", "t5", "t4"]);

    // Two newer transactions arrive between the requests. With OFFSET they would push t4 and t3 onto the second page.
    await insertRows(w, [
      { transactionId: "t7", occurredAt: "2026-10-03 12:00:07+00", eventPosition: 7 },
      { transactionId: "t8", occurredAt: "2026-10-03 12:00:08+00", eventPosition: 8 }
    ]);

    const second = await getPage(w, { limit: "3", after: first.body.next! });
    assert.deepStrictEqual(idsOf(second), ["t3", "t2", "t1"]);
    assert.strictEqual(second.body.next, null);

    // A fresh read starts from the new head.
    assert.deepStrictEqual(idsOf(await getPage(w, { limit: "3" })), ["t8", "t7", "t6"]);
  });

  it("serves only the asked wallet's rows", async () => {
    const mine = walletId();
    const other = walletId();
    await insertRows(mine, [{ transactionId: "mine-1", occurredAt: "2026-10-03 12:00:01+00", eventPosition: 1 }]);
    await insertRows(other, [{ transactionId: "other-1", occurredAt: "2026-10-03 12:00:02+00", eventPosition: 2 }]);
    assert.deepStrictEqual(await readAll(mine, 10), ["mine-1"]);
  });

  it("answers an empty list with next = null", async () => {
    const page = await getPage(walletId());
    assert.strictEqual(page.status, 200);
    assert.deepStrictEqual(page.body, { transactions: [], next: null });
  });

  it("serves a default page of 20 and caps the limit at 100", async () => {
    const w = walletId();
    await insertRows(w, Array.from({ length: 25 }, (_, i) => ({ transactionId: `t${String(i).padStart(2, "0")}`, occurredAt: `2026-10-03 12:00:00.${String(i).padStart(3, "0")}+00`, eventPosition: i + 1 })));
    const page = await getPage(w);
    assert.strictEqual(idsOf(page).length, 20);
    assert.ok(typeof page.body.next === "string");
    assert.strictEqual((await getPage(w, { limit: "101" })).status, 400);
  });

  it("answers 400 with a problem body (and does no work) for a bad limit or a bad cursor", async () => {
    const w = walletId();
    const bad: ReadonlyArray<Record<string, string>> = [{ limit: "0" }, { limit: "abc" }, { limit: "-3" }, { after: "not-a-cursor" }, { after: "" }];
    for (const query of bad) {
      const page = await getPage(w, query);
      assert.strictEqual(page.status, 400, JSON.stringify(query));
      assert.ok(typeof page.body.detail === "string");
    }
  });
});
