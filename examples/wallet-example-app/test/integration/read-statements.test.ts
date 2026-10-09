// Runs under Node (Testcontainers) - see NOTES.md. What a consistent read sends to the database (docs/adr/0015-read-consistency-by-marker.md): the first look is ONE statement of the
// framework's (where the log ends, where the view is, whether anything it handles is pending), and the application's own query is a separate one. Counted with pg_stat_statements on an
// instance that runs only the API, so the only statements are the reads'. Before the first look was fused a default read sent four (end of the log, progress, pending, the view's query).
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { Layer, ManagedRuntime, Redacted } from "effect";
import { PgClient } from "@effect/sql-pg";
import { Client } from "pg";
import { EventStoreLive } from "@crablet/eventstore";
import { CommandAuditStoreLive } from "@crablet/eventstore/CommandAuditStore";
import { CommandExecutorLive } from "@crablet/commands";
import { startTestDb, type TestDb } from "@crablet/test-support";
import { startWalletAppForTest, type CoreServices } from "../support/startWalletAppForTest.ts";
import { applyAppMigrations } from "../support/applyAppMigrations.ts";

let db: TestDb;
let monitor: Client;
before(async () => {
  db = await startTestDb({ postgresArgs: ["-c", "shared_preload_libraries=pg_stat_statements"] });
  await applyAppMigrations(db.connInfo);
  monitor = new Client({ host: db.connInfo.host, port: db.connInfo.port, database: db.connInfo.database, user: db.connInfo.username, password: db.connInfo.password, application_name: "monitor" });
  await monitor.connect();
  await monitor.query("CREATE EXTENSION IF NOT EXISTS pg_stat_statements");
}, { timeout: 120_000 });
after(async () => {
  await monitor.end();
  await db.stop();
});

const make = () =>
  ManagedRuntime.make(
    Layer.provideMerge(
      Layer.mergeAll(CommandExecutorLive, EventStoreLive, CommandAuditStoreLive),
      PgClient.layer({ host: db.connInfo.host, port: db.connInfo.port, database: db.connInfo.database, username: db.connInfo.username, password: Redacted.make(db.connInfo.password), applicationName: "wallet" })
    ) as unknown as Layer.Layer<CoreServices, never>
  );

describe("statements per consistent read", () => {
  it("a read of an up-to-date view is two statements: the framework's first look, and the application's query", { timeout: 120_000 }, async () => {
    // a full instance creates wallets and lets every view catch up, then stops
    const rt1 = make();
    const full = await startWalletAppForTest(rt1);
    const ids = Array.from({ length: 10 }, () => `w-${crypto.randomUUID()}`);
    const markers: string[] = [];
    for (const id of ids) {
      await fetch(`${full.baseUrl}/api/commands/open_wallet`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ walletId: id, owner: "x", initialBalance: 1 }) });
      const deposit = await fetch(`${full.baseUrl}/api/commands/deposit`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ depositId: crypto.randomUUID(), walletId: id, amount: 5, description: "d" }) });
      markers.push(((await deposit.json()) as { marker: string }).marker);
    }
    const last = ids[ids.length - 1]!;
    for (const suffix of ["", "/transactions", "/summary"]) await (await fetch(`${full.baseUrl}/api/wallets/${last}${suffix}`)).text(); // waits for every view
    await new Promise((r) => setTimeout(r, 500));
    await full.stop();
    await rt1.dispose();

    // an instance with only the API: no pollers, so no statements but the reads'
    const rt2 = make();
    const api = await startWalletAppForTest(rt2, undefined, undefined, { roles: new Set(["api"]) as never });
    await new Promise((r) => setTimeout(r, 1000));
    try {
      const N = 20;
      const cases: Array<[string, (i: number) => string, string]> = [
        ["default (strict, the end of the log)", (i) => `/api/wallets/${ids[i % ids.length]}`, "wallet_balance_view"],
        ["with the write's marker", (i) => `/api/wallets/${ids[i % ids.length]}?consistentWith=${markers[i % markers.length]}`, "wallet_balance_view"],
        ["the transactions view", (i) => `/api/wallets/${ids[i % ids.length]}/transactions`, "wallet_transaction_view"],
        ["the summary view", (i) => `/api/wallets/${ids[i % ids.length]}/summary`, "wallet_summary_view"]
      ];
      for (const [name, path, table] of cases) {
        await monitor.query("SELECT pg_stat_statements_reset()");
        for (let i = 0; i < N; i++) {
          const res = await fetch(`${api.baseUrl}${path(i)}`);
          assert.strictEqual(res.status, 200, `${name}: ${path(i)}`);
          await res.text();
        }
        const rows = await monitor.query<{ query: string; calls: string }>(
          `SELECT query, calls::text FROM pg_stat_statements
            WHERE dbid = (SELECT oid FROM pg_database WHERE datname = current_database())
              AND query NOT ILIKE '%pg_stat_statements%' AND query !~* '^(BEGIN|COMMIT|ROLLBACK|SET|LISTEN|SELECT 1$)'`
        );
        const statements = rows.rows.map((r) => ({ query: r.query, calls: Number(r.calls) }));
        const perRead = statements.reduce((a, s) => a + s.calls, 0) / N;
        assert.strictEqual(perRead, 2, `${name}: statements per read (${statements.map((s) => `${s.calls}x ${s.query.slice(0, 60)}`).join(" | ")})`);
        // the fence between the framework's SQL and the application's: the view's query names no crablet_ table, and the first look names no application table
        const app = statements.filter((s) => s.query.includes(table));
        const framework = statements.filter((s) => s.query.includes("crablet_events"));
        assert.strictEqual(app.length, 1, `${name}: one application statement`);
        assert.strictEqual(framework.length, 1, `${name}: one framework statement`);
        assert.ok(!app[0]!.query.includes("crablet_"), `${name}: the application's query does not touch the framework's tables`);
        assert.ok(!/wallet_(balance|transaction|summary|statement)_view/.test(framework[0]!.query), `${name}: the first look does not touch the application's tables`);
      }
    } finally {
      await api.stop();
      await rt2.dispose();
    }
  });
});
