// Runs under Node (Testcontainers) - see NOTES.md. A wallet's first command opens its statement period (the period model, `WalletPeriodModel`, turns it in the command's own append; it used to be a `prepare` step). Commands that race on a wallet that has none yet
// must open ONE statement, and an event appended ahead of a command's own must never be left committed with no audit row of a command (the chaos page's check "every transaction of events has one command
// in the audit"). Found by the end-to-end test behind PgBouncer: the append that opens the statement had no condition, so racing commands each opened their own (179 openings for 60 wallets, plain Postgres),
// and a racer that then ended as an idempotent repeat left its opening committed without an audit row (an idempotent result is not audited).
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { Effect, Exit, Layer, ManagedRuntime, Redacted } from "effect";
import { PgClient } from "@effect/sql-pg";
import { Client } from "pg";
import { EventStoreLive } from "@crablet/eventstore";
import { CommandAuditStoreLive } from "@crablet/eventstore/CommandAuditStore";
import { CommandExecutor, CommandExecutorLive } from "@crablet/commands";
import { startTestDb, type TestDb } from "@crablet/test-support";
import { applyAppMigrations } from "../support/applyAppMigrations.ts";
import { OpenWallet } from "../../src/domain/commands/OpenWalletCommand.ts";
import { Deposit } from "../../src/domain/commands/DepositCommand.ts";

let db: TestDb;
let runtime: ManagedRuntime.ManagedRuntime<CommandExecutor, never>;
let probe: Client;

before(async () => {
  db = await startTestDb();
  await applyAppMigrations(db.connInfo);
  runtime = ManagedRuntime.make(
    Layer.provideMerge(
      Layer.mergeAll(CommandExecutorLive, EventStoreLive, CommandAuditStoreLive),
      PgClient.layer({ host: db.connInfo.host, port: db.connInfo.port, database: db.connInfo.database, username: db.connInfo.username, password: Redacted.make(db.connInfo.password), maxConnections: 20 })
    ) as never
  );
  probe = new Client({ host: db.connInfo.host, port: db.connInfo.port, database: db.connInfo.database, user: db.connInfo.username, password: db.connInfo.password });
  await probe.connect();
}, { timeout: 60_000 });
after(async () => {
  await probe.end();
  await runtime.dispose();
  await db.stop();
});

const exec = <A>(effect: Effect.Effect<A, unknown, any>) => runtime.runPromise(Effect.exit(effect as never)) as Promise<Exit.Exit<unknown, { _tag?: string }>>;
const openWallet = (walletId: string) => exec(Effect.flatMap(CommandExecutor, (ex) => ex.run(OpenWallet, { walletId, owner: "x", initialBalance: 5 })));
const deposit = (walletId: string, depositId: string) => exec(Effect.flatMap(CommandExecutor, (ex) => ex.run(Deposit, { depositId, walletId, amount: 3, description: "race" })));

const statementsPerWallet = async (ids: ReadonlyArray<string>) =>
  (await probe.query<{ wallet_id: string; n: number }>(
    `SELECT data->>'walletId' AS wallet_id, count(*)::int AS n FROM crablet_events WHERE type = 'WalletStatementOpened' AND data->>'walletId' = ANY($1) GROUP BY 1`, [ids]
  )).rows;
const eventsWithNoCommand = async () =>
  (await probe.query<{ type: string; n: number }>(
    `SELECT e.type, count(DISTINCT e.transaction_id)::int AS n FROM crablet_events e WHERE NOT EXISTS (SELECT 1 FROM crablet_commands k WHERE k.transaction_id = e.transaction_id) GROUP BY 1`
  )).rows;

describe("racing commands on a wallet with no statement period yet", () => {
  it("the same deposit sent three times at once: one deposit, one statement opening, and no event without an audit row", { timeout: 120_000 }, async () => {
    const ids = Array.from({ length: 40 }, () => `w-${crypto.randomUUID()}`);
    for (const id of ids) await openWallet(id);
    for (const id of ids) {
      const depositId = crypto.randomUUID();
      const exits = await Promise.all([1, 2, 3].map(() => deposit(id, depositId)));
      for (const e of exits) assert.ok(Exit.isSuccess(e) || (e.cause as unknown as { toString(): string }).toString().includes("Conflict"), `a repeat is a success (or, at worst, a conflict that exhausted its retries): ${String(e)}`);
    }
    const deposits = (await probe.query<{ n: number }>(`SELECT count(*)::int AS n FROM crablet_events WHERE type = 'DepositMade' AND data->>'walletId' = ANY($1)`, [ids])).rows[0]!.n;
    assert.strictEqual(deposits, ids.length, "one deposit per wallet");
    const openings = await statementsPerWallet(ids);
    assert.deepStrictEqual(openings.filter((r) => r.n !== 1), [], "every wallet opened its statement exactly once");
    assert.deepStrictEqual(await eventsWithNoCommand(), [], "every transaction of events has a command in the audit");
  });

  it("different deposits at once on a fresh wallet: it opens ONE statement, whichever of them wins, and no event is left without an audit row", { timeout: 120_000 }, async () => {
    const ids = Array.from({ length: 40 }, () => `w-${crypto.randomUUID()}`);
    for (const id of ids) await openWallet(id);
    for (const id of ids) await Promise.all([1, 2, 3, 4].map(() => deposit(id, crypto.randomUUID())));
    const openings = await statementsPerWallet(ids);
    assert.deepStrictEqual(openings.filter((r) => r.n !== 1), [], "every wallet opened its statement exactly once");
    assert.deepStrictEqual(await eventsWithNoCommand(), [], "every transaction of events has a command in the audit");
  });
});
