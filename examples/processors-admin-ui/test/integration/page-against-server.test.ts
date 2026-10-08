// Runs under Node (Testcontainers). The page against a REAL application (the wallet example, with its admin API mounted behind a token) on a real Postgres, without a browser.
//
// A tiny driver plays the part of Foldkit's runtime: it feeds a Message to the page's own `update`, runs every Command the update returns (the real Effects, with the real
// derived client and `fetch`), and feeds each result Message back, until nothing is left to run. What it ends with is the Model the page would be showing. `globalThis.location`
// is the base URL a browser would supply for the page's relative URLs. Nothing here is about wallets: the page only knows the admin API.
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { Layer, ManagedRuntime, Redacted, Effect } from "effect";
import { PgClient } from "@effect/sql-pg";
import { Client } from "pg";
import * as AsyncData from "foldkit/asyncData";
import { EventStoreLive } from "@crablet/eventstore";
import { CommandAuditStoreLive } from "@crablet/eventstore/CommandAuditStore";
import { CommandExecutorLive } from "@crablet/commands";
import { startTestDb, type TestDb } from "@crablet/test-support";
import { startWalletAppForTest, type CoreServices, type RunningWalletApp } from "../../../wallet-example-app/test/support/startWalletAppForTest.ts";
import { applyAppMigrations } from "../../../wallet-example-app/test/support/applyAppMigrations.ts";
import { Message, init, update, type Model } from "../../src/main.ts";
import type { ProcessorInfo } from "../../src/api.ts";

const TOKEN = "page-test-token";
let db: TestDb;
let runtime: ManagedRuntime.ManagedRuntime<CoreServices, never>;
let app: RunningWalletApp;

before(async () => {
  db = await startTestDb();
  await applyAppMigrations(db.connInfo);
  const pgLayer = PgClient.layer({ host: db.connInfo.host, port: db.connInfo.port, database: db.connInfo.database, username: db.connInfo.username, password: Redacted.make(db.connInfo.password) });
  const layer = Layer.provideMerge(Layer.mergeAll(CommandExecutorLive, EventStoreLive, CommandAuditStoreLive), pgLayer) as unknown as Layer.Layer<CoreServices, never>;
  runtime = ManagedRuntime.make(layer);
  app = await startWalletAppForTest(runtime, undefined, TOKEN);
  (globalThis as { location?: unknown }).location = new URL(app.baseUrl);
}, { timeout: 90_000 });
after(async () => {
  delete (globalThis as { location?: unknown }).location;
  await app.stop();
  await runtime.dispose();
  await db.stop();
});

// #region driver
// Feed `messages` through the page one after another, running every Command to completion in between.
const drive = async (from: Model, ...messages: ReadonlyArray<Message>): Promise<Model> => {
  let model = from;
  const queue: Array<Message> = [...messages];
  while (queue.length > 0) {
    const result = update(model, queue.shift()!);
    model = result.model;
    for (const command of result.commands ?? []) queue.unshift((await Effect.runPromise(command.effect as Effect.Effect<Message>)) as Message);
  }
  return model;
};
// #endregion driver

const connect = (token: string) => drive(init().model, Message.ChangedToken({ value: token }), Message.SubmittedToken());
const shown = (model: Model): ReadonlyArray<ProcessorInfo> => {
  assert.ok(AsyncData.isSuccess(model.processors), `the list is shown, not ${model.processors._tag}`);
  return model.processors.data;
};
const find = (model: Model, kind: string, id: string) => shown(model).find((p) => p.kind === kind && p.id === id)!;
const sql = async (text: string) => {
  const client = new Client({ host: db.connInfo.host, port: db.connInfo.port, database: db.connInfo.database, user: db.connInfo.username, password: db.connInfo.password });
  await client.connect();
  try { await client.query(text); } finally { await client.end(); }
};
const OUTBOX_ID = '["wallet-events","LogPublisher"]';

describe("the processors page against a real application", () => {
  it("a wrong token ends the session (the page asks again); the right one lists every processor of every kind", async () => {
    const refused = await connect("not-the-token");
    assert.strictEqual(refused.token, null);
    assert.ok(AsyncData.isIdle(refused.processors));

    const model = await connect(TOKEN);
    assert.strictEqual(model.token, TOKEN);
    assert.deepStrictEqual(shown(model).map((p) => `${p.kind}/${p.id}`), [
      "automations/wallet-opened-welcome-notification", `outbox/${OUTBOX_ID}`,
      "views/wallet-balance-view", "views/wallet-statement-view", "views/wallet-summary-view", "views/wallet-transaction-view"
    ]);
    assert.ok(shown(model).every((p) => p.status === "ACTIVE" && p.errorCount === 0));
  });

  it("pause then resume, through the page: the status in the list follows, and the notice says what happened", async () => {
    const connected = await connect(TOKEN);
    const paused = await drive(connected, Message.ClickedPause({ kind: "views", id: "wallet-balance-view" }));
    assert.strictEqual(find(paused, "views", "wallet-balance-view").status, "PAUSED");
    assert.deepStrictEqual(paused.notice, { ok: true, text: "Paused wallet-balance-view: it handles nothing until it is resumed." });
    assert.strictEqual(paused.acting, null);
    const resumed = await drive(paused, Message.ClickedResume({ kind: "views", id: "wallet-balance-view" }));
    assert.strictEqual(find(resumed, "views", "wallet-balance-view").status, "ACTIVE");
  });

  it("a FAILED processor shows its error, and Reset (asked, then confirmed) brings it back with no errors", async () => {
    await sql("UPDATE crablet_view_progress SET status = 'FAILED', error_count = 10, last_error = 'projection exploded' WHERE view_name = 'wallet-summary-view'");
    const failed = await connect(TOKEN);
    const row = find(failed, "views", "wallet-summary-view");
    assert.deepStrictEqual([row.status, row.errorCount, row.lastError], ["FAILED", 10, "projection exploded"]);

    const asked = await drive(failed, Message.ClickedReset({ kind: "views", id: "wallet-summary-view" }));
    assert.deepStrictEqual(asked.confirmingReset, { kind: "views", id: "wallet-summary-view" });
    assert.strictEqual(find(asked, "views", "wallet-summary-view").status, "FAILED", "asking changed nothing");
    const done = await drive(asked, Message.ConfirmedReset());
    const after = find(done, "views", "wallet-summary-view");
    // reset clears the error COUNT; the text of the last error stays (the page shows it as history)
    assert.deepStrictEqual([after.status, after.errorCount, after.lastError], ["ACTIVE", 0, "projection exploded"]);
    assert.strictEqual(done.confirmingReset, null);
  });

  it("an outbox publisher, whose id is a JSON pair, can be paused from the page", async () => {
    const paused = await drive(await connect(TOKEN), Message.ClickedPause({ kind: "outbox", id: OUTBOX_ID }));
    assert.strictEqual(find(paused, "outbox", OUTBOX_ID).status, "PAUSED");
    await drive(paused, Message.ClickedResume({ kind: "outbox", id: OUTBOX_ID }));
  });

  it("an action on a processor that is not there is shown as a refusal, not a crash", async () => {
    const model = await drive(await connect(TOKEN), Message.ClickedPause({ kind: "views", id: "gone" }));
    assert.deepStrictEqual(model.notice, { ok: false, text: 'Could not pause gone: No processor "gone" of kind "views".' });
    assert.strictEqual(model.token, TOKEN, "the session goes on");
  });
});
