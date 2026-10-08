// Runs under Node (Testcontainers) - see NOTES.md. The three modules' management services (views, automations, outbox) on the wallet's real processors and a real
// database: the progress details each adds to the generic service, the failure details the admin API lists, and the backlog counted against each processor's own selection.
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { Effect, Layer, ManagedRuntime, Redacted } from "effect";
import { PgClient } from "@effect/sql-pg";
import { Client } from "pg";
import { EventStoreLive } from "@crablet/eventstore";
import { CommandAuditStoreLive } from "@crablet/eventstore/CommandAuditStore";
import { CommandExecutorLive } from "@crablet/commands";
import { startTestDb, type TestDb } from "@crablet/test-support";
import { makeViewManagementService, type ViewManagementService } from "@crablet/views/ViewManagementService";
import { makeAutomationManagementService, type AutomationManagementService } from "@crablet/automations/AutomationManagementService";
import { makeOutboxManagementService, type OutboxManagementService } from "@crablet/outbox/OutboxManagementService";
import { startWalletAppForTest, type CoreServices, type RunningWalletApp } from "../support/startWalletAppForTest.ts";
import { applyAppMigrations } from "../support/applyAppMigrations.ts";

let db: TestDb;
let runtime: ManagedRuntime.ManagedRuntime<CoreServices, never>;
let app: RunningWalletApp;
let views: ViewManagementService;
let automations: AutomationManagementService;
let outbox: OutboxManagementService;

before(async () => {
  db = await startTestDb();
  await applyAppMigrations(db.connInfo);
  const pgLayer = PgClient.layer({ host: db.connInfo.host, port: db.connInfo.port, database: db.connInfo.database, username: db.connInfo.username, password: Redacted.make(db.connInfo.password) });
  const layer = Layer.provideMerge(Layer.mergeAll(CommandExecutorLive, EventStoreLive, CommandAuditStoreLive), pgLayer) as unknown as Layer.Layer<CoreServices, never>;
  runtime = ManagedRuntime.make(layer);
  app = await startWalletAppForTest(runtime);
  // the services read the progress tables of the running app's processors
  ({ views, automations, outbox } = await runtime.runPromise(
    Effect.gen(function* () {
      return {
        views: yield* makeViewManagementService(app.processors.viewsHandle),
        automations: yield* makeAutomationManagementService(app.processors.automationsHandle),
        outbox: yield* makeOutboxManagementService(app.processors.outboxHandle)
      };
    })
  ));
}, { timeout: 90_000 });

after(async () => {
  await app.stop();
  await runtime.dispose();
  await db.stop();
});

const run = <A, E>(effect: Effect.Effect<A, E, CoreServices>) => runtime.runPromise(effect as Effect.Effect<A, E, never>);
const sql = async (text: string) => {
  const client = new Client({ host: db.connInfo.host, port: db.connInfo.port, database: db.connInfo.database, user: db.connInfo.username, password: db.connInfo.password });
  await client.connect();
  try { await client.query(text); } finally { await client.end(); }
};
const until = async <T>(read: () => Promise<T>, ok: (v: T) => boolean, what: string, ms = 20_000): Promise<T> => {
  const end = Date.now() + ms;
  for (;;) {
    const v = await read();
    if (ok(v)) return v;
    if (Date.now() > end) assert.fail(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 200));
  }
};
const OUTBOX_ID = '["wallet-events","LogPublisher"]';

describe("the modules' management services on the wallet's processors", () => {
  it("each module's progress details: the row of one processor, all of them, and null for one that does not exist", async () => {
    const open = await fetch(`${app.baseUrl}/api/commands/open_wallet`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ walletId: `w-${crypto.randomUUID()}`, owner: "Ada", initialBalance: 5 }) });
    assert.strictEqual(open.status, 201);

    const view = await until(() => run(views.getProgressDetails("wallet-balance-view")), (d) => d !== null && d.lastPosition > 0n, "the balance view to process");
    assert.deepStrictEqual([view!.viewName, view!.status, view!.errorCount, view!.lastError], ["wallet-balance-view", "ACTIVE", 0, null]);
    assert.strictEqual((await run(views.getAllProgressDetails)).length, 4);
    assert.strictEqual(await run(views.getProgressDetails("no-such-view")), null);

    const automation = await until(() => run(automations.getProgressDetails("wallet-opened-welcome-notification")), (d) => d !== null && d.lastPosition > 0n, "the automation to process");
    assert.deepStrictEqual([automation!.automationName, automation!.status, automation!.errorCount], ["wallet-opened-welcome-notification", "ACTIVE", 0]);
    assert.strictEqual((await run(automations.getAllProgressDetails)).length, 1);
    assert.strictEqual(await run(automations.getProgressDetails("no-such-automation")), null);

    const publisher = await until(() => run(outbox.getProgressDetails("wallet-events", "LogPublisher")), (d) => d !== null && d.lastPosition > 0n, "the outbox to publish");
    assert.deepStrictEqual([publisher!.topic, publisher!.publisher, publisher!.status, publisher!.errorCount], ["wallet-events", "LogPublisher", "ACTIVE", 0]);
    assert.strictEqual((await run(outbox.getAllProgressDetails)).length, 1);
    assert.strictEqual(await run(outbox.getProgressDetails("wallet-events", "NoSuchPublisher")), null);
  });

  it("the failure details of each module, as the admin API lists them, are keyed by the processor's id", async () => {
    await sql("UPDATE crablet_view_progress SET error_count = 2, last_error = 'view trouble' WHERE view_name = 'wallet-balance-view'");
    await sql("UPDATE crablet_automation_progress SET error_count = 4, last_error = 'automation trouble'");
    await sql("UPDATE crablet_outbox_topic_progress SET error_count = 6, last_error = 'outbox trouble'");
    assert.deepStrictEqual((await run(views.getAllDetails)).get("wallet-balance-view"), { errorCount: 2, lastError: "view trouble" });
    assert.deepStrictEqual((await run(automations.getAllDetails)).get("wallet-opened-welcome-notification"), { errorCount: 4, lastError: "automation trouble" });
    assert.deepStrictEqual((await run(outbox.getAllDetails)).get(OUTBOX_ID), { errorCount: 6, lastError: "outbox trouble" });
  });

  it("the backlog is counted against each processor's own selection, and the services answer null for an id they do not run", async () => {
    // a view and an automation of this wallet do not select the same events: both have caught up, so both have nothing pending, whatever the head of the log is
    for (const service of [views, automations, outbox]) {
      const id = service === views ? "wallet-balance-view" : service === automations ? "wallet-opened-welcome-notification" : OUTBOX_ID;
      const backlog = await until(() => run(service.getBacklog(id)), (b) => b !== null && b.pendingEvents === 0, `${id} to have nothing pending`);
      assert.ok(backlog!.cursor.position > 0n, `${id} has a cursor`);
      assert.strictEqual(await run(service.getBacklog("not-a-processor")), null);
    }
  });
});
