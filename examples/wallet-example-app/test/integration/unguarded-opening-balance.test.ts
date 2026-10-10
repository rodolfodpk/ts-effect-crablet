// Runs under Node (Testcontainers). The duplicate-opening unit test shows the model drops a deposit when a stale second `WalletStatementOpened` follows it. This shows the log does arise: wallets whose first
// deposits race. With a `prepare` that opens the statement WITHOUT a condition (what the wallet's period resolver did before it was fixed, and before the framework took the period over) every wallet lost money (60 of 60 in the first run); with the real Deposit none does.
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { Effect, Exit, Layer, ManagedRuntime, Redacted } from "effect";
import { PgClient } from "@effect/sql-pg";
import { Client } from "pg";
import { EventStore, EventStoreLive } from "@crablet/eventstore";
import { CommandAuditStoreLive } from "@crablet/eventstore/CommandAuditStore";
import { CommandExecutor, CommandExecutorLive } from "@crablet/commands";
import { concurrent, defineCommand, emit } from "@crablet/commands/Command";
import { startTestDb, type TestDb } from "@crablet/test-support";
import { applyAppMigrations } from "../support/applyAppMigrations.ts";
import { Deposit } from "../../src/domain/commands/DepositCommand.ts";
import { OpenWallet } from "../../src/domain/commands/OpenWalletCommand.ts";
import { DepositContract } from "../../src/domain/WalletContracts.ts";
import { DepositMade, WalletModel, WalletStatementOpened } from "../../src/domain/WalletModel.ts";
import * as Tag from "@crablet/eventstore/Tag";
import * as WalletTags from "../../src/domain/WalletTags.ts";

let db: TestDb;
let runtime: ManagedRuntime.ManagedRuntime<CommandExecutor | EventStore, never>;
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

// A deposit whose prepare opens the statement the old way: read the balance, append the opening, no condition.
const UnguardedDeposit = defineCommand({
  ...DepositContract,
  prepare: (c: any, es: any) =>
    Effect.gen(function* () {
      const statementId = `wallet:${c.walletId}:${year}-${String(month).padStart(2, "0")}`;
      const isOpen = yield* es.exists(WalletStatementOpened.where({ [WalletTags.STATEMENT_ID]: statementId }));
      if (!isOpen) {
        const balance = (yield* WalletModel.of({ id: c.walletId, year, month }).load(es)).state.balance;
        yield* es.append([WalletStatementOpened({ walletId: c.walletId, statementId, year, month, openingBalance: balance, openedAt: now.toISOString() })]);
      }
      return { year, month, statementId };
    }),
  model: (c: any, period: any) => WalletModel.of({ id: c.walletId, year: period.year, month: period.month }),
  consistency: (c: any) => concurrent({ guard: WalletModel.lifecycleQuery(c.walletId) }),
  decide: (wallet: any, c: any, period: any) => emit(DepositMade({ ...c, newBalance: wallet.balance + c.amount, depositedAt: now.toISOString() }, [Tag.of(WalletTags.YEAR, String(period.year)), Tag.of(WalletTags.MONTH, String(period.month)), Tag.of(WalletTags.STATEMENT_ID, period.statementId)]))
} as never);

const exec = <A>(effect: Effect.Effect<A, unknown, any>) => runtime.runPromise(Effect.exit(effect as never)) as Promise<Exit.Exit<unknown, unknown>>;
const run = (command: any, input: unknown) => exec(Effect.flatMap(CommandExecutor, (ex) => (ex as any).run(command, input)));

const balanceOf = (id: string) =>
  runtime.runPromise(Effect.flatMap(EventStore, (es) => WalletModel.of({ id, year, month }).load(es)) as never).then((r: any) => r.state.balance as number);

// Four deposits of different amounts race on each of 60 fresh wallets; returns the wallets whose balance is not initial + their sum, and those with more than one opening.
const race = async (command: any) => {
  const ids = Array.from({ length: 60 }, () => `w-${crypto.randomUUID()}`);
  const amounts = [1, 2, 4, 8];
  for (const id of ids) await run(OpenWallet, { walletId: id, owner: "x", initialBalance: 100 });
  for (const id of ids) await Promise.all(amounts.map((a) => run(command, { depositId: crypto.randomUUID(), walletId: id, amount: a, description: "race" })));
  const openings = (await probe.query<{ n: number }>(`SELECT count(*)::int AS n FROM crablet_events WHERE type = 'WalletStatementOpened' AND data->>'walletId' = ANY($1) GROUP BY data->>'walletId'`, [ids])).rows;
  const expected = 100 + amounts.reduce((a, b) => a + b, 0);
  const balances = await Promise.all(ids.map(balanceOf));
  return { wrong: balances.filter((b) => b !== expected).length, doubled: openings.filter((r) => r.n > 1).length, seen: [...new Set(balances)], expected };
};

describe("racing first deposits on fresh wallets", () => {
  it("the real Deposit: every wallet ends with initial + the sum of its deposits, and one opening", { timeout: 180_000 }, async () => {
    const r = await race(Deposit);
    assert.deepStrictEqual({ wrong: r.wrong, doubled: r.doubled }, { wrong: 0, doubled: 0 }, `balances seen: ${r.seen.join(", ")} (expected ${r.expected})`);
  });

  it("control, the statement opening without a condition: wallets lose deposits (so the test above can fail)", { timeout: 180_000 }, async () => {
    const r = await race(UnguardedDeposit);
    console.log(`unguarded opening: ${r.doubled} of 60 wallets opened more than once, ${r.wrong} ended with a wrong balance (expected ${r.expected}, seen ${r.seen.join(", ")})`);
    assert.ok(r.wrong > 0, "the unconditioned opening loses deposits");
  });
});
