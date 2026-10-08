// Runs under Node (Testcontainers) - see NOTES.md. The admin API over the wallet's real processors (views, automation, outbox) and a real database: who may call it,
// what it lists, and that pause, resume and reset change what the processors do.
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { Layer, ManagedRuntime, Redacted } from "effect";
import { PgClient } from "@effect/sql-pg";
import { Client } from "pg";
import { EventStoreLive } from "@crablet/eventstore";
import { CommandAuditStoreLive } from "@crablet/eventstore/CommandAuditStore";
import { CommandExecutorLive } from "@crablet/commands";
import { startTestDb, type TestDb } from "@crablet/test-support";
import { startWalletAppForTest, type CoreServices, type RunningWalletApp } from "../support/startWalletAppForTest.ts";
import { applyAppMigrations } from "../support/applyAppMigrations.ts";

const TOKEN = "admin-token-for-tests";
const OUTBOX_ID = '["wallet-events","LogPublisher"]';

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
  app = await startWalletAppForTest(runtime, undefined, TOKEN);
}, { timeout: 60_000 });

after(async () => {
  await app.stop();
  await runtime.dispose();
  await db.stop();
});

interface Info { kind: string; id: string; description: string | null; status: string; errorCount: number | null; lastError: string | null; cursorPosition: string | null; pendingEvents: number | null; oldestPendingSeconds: number | null }
const admin = (method: string, path: string, token: string | null = TOKEN) =>
  fetch(`${app.baseUrl}${path}`, { method, headers: token === null ? {} : { Authorization: `Bearer ${token}` } });
const list = async (): Promise<ReadonlyArray<Info>> => ((await (await admin("GET", "/admin/processors")).json()) as { processors: Array<Info> }).processors;
const one = async (kind: string, id: string): Promise<Info> => (await list()).find((p) => p.kind === kind && p.id === id)!;
const post = (command: string, body: unknown) =>
  fetch(`${app.baseUrl}/api/commands/${command}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
const sql = async (text: string, params: ReadonlyArray<unknown> = []) => {
  const client = new Client({ host: db.connInfo.host, port: db.connInfo.port, database: db.connInfo.database, user: db.connInfo.username, password: db.connInfo.password });
  await client.connect();
  try { await client.query(text, params as unknown[]); } finally { await client.end(); }
};
const until = async <T>(read: () => Promise<T>, ok: (v: T) => boolean, what: string, ms = 20_000): Promise<T> => {
  const end = Date.now() + ms;
  for (;;) {
    const v = await read();
    if (ok(v)) return v;
    if (Date.now() > end) assert.fail(`timed out waiting for ${what}; last: ${JSON.stringify(v)}`);
    await new Promise((r) => setTimeout(r, 200));
  }
};

describe("the wallet's admin API", () => {
  it("is behind the bearer token: none or a wrong one is a 401 problem, and so is every action", async () => {
    for (const [method, path] of [["GET", "/admin/processors"], ["POST", "/admin/processors/views/wallet-balance-view/pause"], ["POST", "/admin/processors/views/wallet-balance-view/reset"]] as const) {
      for (const token of [null, "wrong"]) {
        const res = await admin(method, path, token);
        assert.strictEqual(res.status, 401, `${method} ${path} with ${token}`);
        assert.match(res.headers.get("content-type") ?? "", /application\/problem\+json/);
      }
    }
    assert.strictEqual((await one("views", "wallet-balance-view")).status, "ACTIVE", "the refused pause did nothing");
  });

  it("lists the processors of the three modules with their description, status and failure details (the SQL of every module's details reached the right id)", async () => {
    const all = await list();
    assert.deepStrictEqual(all.map((p) => `${p.kind}/${p.id}`), [
      `automations/wallet-opened-welcome-notification`, `outbox/${OUTBOX_ID}`,
      "views/wallet-balance-view", "views/wallet-statement-view", "views/wallet-summary-view", "views/wallet-transaction-view"
    ]);
    for (const p of all) {
      assert.strictEqual(p.status, "ACTIVE", p.id);
      assert.strictEqual(p.errorCount, 0, `${p.kind}/${p.id}: the failure details were read from its progress table`);
      assert.strictEqual(p.lastError, null);
    }
    assert.strictEqual((await one("views", "wallet-balance-view")).description, "The balance of each wallet");
    assert.strictEqual((await one("automations", "wallet-opened-welcome-notification")).description, "Sends a welcome notification when a wallet is opened");
    assert.strictEqual((await one("outbox", OUTBOX_ID)).description, null);
  });

  it("shows a processor's cursor and backlog, and pause holds events back until resume", async () => {
    const walletId = `wallet-${crypto.randomUUID()}`;
    assert.strictEqual((await post("open_wallet", { walletId, owner: "Ada", initialBalance: 10 })).status, 201);
    const caughtUp = await until(() => one("views", "wallet-balance-view"), (p) => p.cursorPosition !== null && p.cursorPosition !== "0" && p.pendingEvents === 0, "the balance view to catch up");
    assert.strictEqual(caughtUp.oldestPendingSeconds, null);

    const paused = await admin("POST", "/admin/processors/views/wallet-balance-view/pause");
    assert.deepStrictEqual(await paused.json(), { kind: "views", id: "wallet-balance-view", status: "PAUSED" });
    assert.strictEqual((await post("deposit", { depositId: crypto.randomUUID(), walletId, amount: 5, description: "while paused" })).status, 201);
    const behind = await until(() => one("views", "wallet-balance-view"), (p) => (p.pendingEvents ?? 0) >= 1, "the paused view to have events waiting");
    assert.strictEqual(behind.status, "PAUSED");
    assert.ok(behind.oldestPendingSeconds !== null && behind.oldestPendingSeconds >= 0, "the age of the first waiting event");
    assert.strictEqual(behind.cursorPosition, caughtUp.cursorPosition, "a paused processor does not move");

    assert.deepStrictEqual(await (await admin("POST", "/admin/processors/views/wallet-balance-view/resume")).json(), { kind: "views", id: "wallet-balance-view", status: "ACTIVE" });
    const after = await until(() => one("views", "wallet-balance-view"), (p) => p.pendingEvents === 0, "the resumed view to catch up");
    assert.notStrictEqual(after.cursorPosition, caughtUp.cursorPosition, "it processed the deposit");
  });

  it("reset takes a FAILED processor back to ACTIVE with no errors, and it carries on from where it was", async () => {
    await sql("UPDATE crablet_view_progress SET status = 'FAILED', error_count = 10, last_error = 'projection exploded' WHERE view_name = 'wallet-summary-view'");
    const failed = await one("views", "wallet-summary-view");
    assert.strictEqual(failed.status, "FAILED");
    assert.strictEqual(failed.errorCount, 10);
    assert.strictEqual(failed.lastError, "projection exploded");

    const walletId = `wallet-${crypto.randomUUID()}`;
    await post("open_wallet", { walletId, owner: "Bo", initialBalance: 1 });
    await until(() => one("views", "wallet-summary-view"), (p) => (p.pendingEvents ?? 0) >= 1, "events to wait for the FAILED view");

    assert.deepStrictEqual(await (await admin("POST", "/admin/processors/views/wallet-summary-view/reset")).json(), { kind: "views", id: "wallet-summary-view", status: "ACTIVE" });
    const reset = await until(() => one("views", "wallet-summary-view"), (p) => p.pendingEvents === 0, "the reset view to catch up");
    assert.strictEqual(reset.status, "ACTIVE");
    assert.strictEqual(reset.errorCount, 0);
  });

  it("the outbox's failure details are found under its JSON-pair id, and a publisher can be paused through the percent-encoded id", async () => {
    await sql("UPDATE crablet_outbox_topic_progress SET error_count = 3, last_error = 'broker down' WHERE topic = 'wallet-events'");
    const outbox = await one("outbox", OUTBOX_ID);
    assert.strictEqual(outbox.errorCount, 3);
    assert.strictEqual(outbox.lastError, "broker down");
    const res = await admin("POST", `/admin/processors/outbox/${encodeURIComponent(OUTBOX_ID)}/pause`);
    assert.deepStrictEqual(await res.json(), { kind: "outbox", id: OUTBOX_ID, status: "PAUSED" });
    await admin("POST", `/admin/processors/outbox/${encodeURIComponent(OUTBOX_ID)}/resume`);
    assert.strictEqual((await one("outbox", OUTBOX_ID)).status, "ACTIVE");
  });

  it("an unknown kind or id is a 404 problem, and nothing else changes", async () => {
    const kind = await admin("POST", "/admin/processors/nope/x/pause");
    assert.strictEqual(kind.status, 404);
    assert.match((await kind.json() as { detail: string }).detail, /No processors of kind "nope"/);
    assert.strictEqual((await admin("POST", "/admin/processors/views/nope/reset")).status, 404);
  });
});
