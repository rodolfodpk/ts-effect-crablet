// Runs under Node (Testcontainers). The duplicate-opening unit test shows the model drops a deposit when a stale second `WalletStatementOpened` follows it. This shows the log does arise: wallets whose first
// deposits race. With an old writer that opens the statement WITHOUT a condition (what the wallet's period resolver did in a command's `prepare` before it was fixed; the framework now
// turns the period itself, and a command can no longer append before its decision) every wallet lost money (60 of 60 in the first run); with the real Deposit none does.
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { Effect, Exit, Layer, ManagedRuntime, Redacted } from "effect";
import { SqlClient } from "effect/sql";
import { PgClient } from "@effect/sql-pg";
import { Client } from "pg";
import { EventStore, EventStoreLive } from "@crablet/eventstore";
import { CommandAuditStoreLive } from "@crablet/eventstore/CommandAuditStore";
import { CommandExecutor, CommandExecutorLive } from "@crablet/commands";
import { startTestDb, type TestDb } from "@crablet/test-support";
import { applyAppMigrations } from "../support/applyAppMigrations.ts";
import { Deposit } from "../../src/domain/commands/DepositCommand.ts";
import { OpenWallet } from "../../src/domain/commands/OpenWalletCommand.ts";
import { DepositMade, WalletModel, WalletStatementOpened } from "../../src/domain/WalletModel.ts";
import * as Tag from "@crablet/eventstore/Tag";
import * as WalletTags from "../../src/domain/WalletTags.ts";

let db: TestDb;
let runtime: ManagedRuntime.ManagedRuntime<CommandExecutor | EventStore | SqlClient.SqlClient, never>;
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

const now = new Date();
const [year, month] = [now.getUTCFullYear(), now.getUTCMonth() + 1];

// An old writer, in a transaction of its own: read whether the statement is open, open it from the balance it read WITHOUT a condition, then record the deposit.
type DepositInput = { readonly depositId: string; readonly walletId: string; readonly amount: number; readonly description: string };
const unguardedDeposit = (c: DepositInput) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const es = yield* EventStore;
    yield* es.withWakeups(sql.withTransaction(Effect.gen(function* () {
      const statementId = `wallet:${c.walletId}:${year}-${String(month).padStart(2, "0")}`;
      const isOpen = yield* es.exists(WalletStatementOpened.where({ [WalletTags.STATEMENT_ID]: statementId }));
      const balance = (yield* WalletModel.of({ id: c.walletId, year, month }).load(es)).state.balance;
      if (!isOpen) yield* es.append([WalletStatementOpened({ walletId: c.walletId, statementId, year, month, openingBalance: balance, openedAt: now.toISOString() })]);
      yield* es.append([DepositMade({ ...c, newBalance: balance + c.amount, depositedAt: now.toISOString() }, [Tag.of(WalletTags.YEAR, String(year)), Tag.of(WalletTags.MONTH, String(month)), Tag.of(WalletTags.STATEMENT_ID, statementId)])]);
    })));
  });

const exec = <A>(effect: Effect.Effect<A, unknown, any>) => runtime.runPromise(Effect.exit(effect as never)) as Promise<Exit.Exit<unknown, unknown>>;
const run = (command: any, input: unknown) => exec(Effect.flatMap(CommandExecutor, (ex) => (ex as any).run(command, input)));
const viaCommand = (command: any) => (input: DepositInput) => run(command, input);

const balanceOf = (id: string) =>
  runtime.runPromise(Effect.flatMap(EventStore, (es) => WalletModel.of({ id, year, month }).load(es)) as never).then((r: any) => r.state.balance as number);

// Four deposits of different amounts race on each of 60 fresh wallets; returns the wallets whose balance is not initial + their sum, and those with more than one opening.
const race = async (deposit: (input: DepositInput) => Promise<Exit.Exit<unknown, unknown>>) => {
  const ids = Array.from({ length: 60 }, () => `w-${crypto.randomUUID()}`);
  const amounts = [1, 2, 4, 8];
  for (const id of ids) await run(OpenWallet, { walletId: id, owner: "x", initialBalance: 100 });
  for (const id of ids) await Promise.all(amounts.map((a) => deposit({ depositId: crypto.randomUUID(), walletId: id, amount: a, description: "race" })));
  const openings = (await probe.query<{ n: number }>(`SELECT count(*)::int AS n FROM crablet_events WHERE type = 'WalletStatementOpened' AND data->>'walletId' = ANY($1) GROUP BY data->>'walletId'`, [ids])).rows;
  const expected = 100 + amounts.reduce((a, b) => a + b, 0);
  const balances = await Promise.all(ids.map(balanceOf));
  return { wrong: balances.filter((b) => b !== expected).length, doubled: openings.filter((r) => r.n > 1).length, seen: [...new Set(balances)], expected };
};

describe("racing first deposits on fresh wallets", () => {
  it("the real Deposit: every wallet ends with initial + the sum of its deposits, and one opening", { timeout: 180_000 }, async () => {
    const r = await race(viaCommand(Deposit));
    assert.deepStrictEqual({ wrong: r.wrong, doubled: r.doubled }, { wrong: 0, doubled: 0 }, `balances seen: ${r.seen.join(", ")} (expected ${r.expected})`);
  });

  it("control, the statement opening without a condition: wallets lose deposits (so the test above can fail)", { timeout: 180_000 }, async () => {
    const r = await race((input) => exec(unguardedDeposit(input)));
    console.log(`unguarded opening: ${r.doubled} of 60 wallets opened more than once, ${r.wrong} ended with a wrong balance (expected ${r.expected}, seen ${r.seen.join(", ")})`);
    assert.ok(r.wrong > 0, "the unconditioned opening loses deposits");
  });
});
