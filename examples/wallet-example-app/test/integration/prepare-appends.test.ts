// Runs under Node (Testcontainers) - see NOTES.md. A measurement of the `prepare` gap (Command.ts, "prepare"): a command that ends as an idempotent repeat commits whatever its `prepare` appended, and writes
// no audit row. The only `prepare` that appends in this repository is `resolveActivePeriod` (the wallet's Deposit, Withdraw and TransferMoney run it). This races every way a wallet command can end
// idempotent or lose a race after `prepare` appended - the same withdrawal three times, transfers in both directions, and the month rollover (close the old statement, open the new one) through a command
// whose `prepare` is given a later "now" - and requires one opening and one closing per wallet and no event whose transaction has no command in the audit.
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { Effect, Exit, Layer, ManagedRuntime, Redacted, Schema } from "effect";
import { PgClient } from "@effect/sql-pg";
import { Client } from "pg";
import { EventStoreLive } from "@crablet/eventstore";
import { CommandAuditStoreLive } from "@crablet/eventstore/CommandAuditStore";
import { CommandExecutor, CommandExecutorLive } from "@crablet/commands";
import { concurrent, defineCommand, emit } from "@crablet/commands/Command";
import { startTestDb, type TestDb } from "@crablet/test-support";
import { applyAppMigrations } from "../support/applyAppMigrations.ts";
import { OpenWallet } from "../../src/domain/commands/OpenWalletCommand.ts";
import { Deposit } from "../../src/domain/commands/DepositCommand.ts";
import { Withdraw } from "../../src/domain/commands/WithdrawCommand.ts";
import { TransferMoney } from "../../src/domain/commands/TransferMoneyCommand.ts";
import { resolveActivePeriod, periodTags } from "../../src/domain/period/WalletStatementPeriodResolver.ts";
import { DepositMade, WalletModel } from "../../src/domain/WalletModel.ts";
import * as WalletTags from "../../src/domain/WalletTags.ts";

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

const exec = <A>(effect: Effect.Effect<A, unknown, any>) => runtime.runPromise(Effect.exit(effect as never)) as Promise<Exit.Exit<unknown, unknown>>;
const run = (command: any, input: unknown) => exec(Effect.flatMap(CommandExecutor, (ex) => (ex as any).run(command, input)));
const openWallet = (walletId: string, initialBalance = 100) => run(OpenWallet, { walletId, owner: "x", initialBalance });
const okOrConflict = (e: Exit.Exit<unknown, unknown>) => Exit.isSuccess(e) || String((e as any).cause).includes("Conflict");

const countOf = async (type: string, ids: ReadonlyArray<string>) =>
  (await probe.query<{ wallet_id: string; n: number }>(`SELECT data->>'walletId' AS wallet_id, count(*)::int AS n FROM crablet_events WHERE type = $1 AND data->>'walletId' = ANY($2) GROUP BY 1`, [type, ids])).rows;
const eventsWithNoCommand = async () =>
  (await probe.query<{ type: string; n: number }>(
    `SELECT e.type, count(DISTINCT e.transaction_id)::int AS n FROM crablet_events e WHERE NOT EXISTS (SELECT 1 FROM crablet_commands k WHERE k.transaction_id = e.transaction_id) GROUP BY 1`
  )).rows;
const wallets = (n: number) => Array.from({ length: n }, () => `w-${crypto.randomUUID()}`);

describe("what a `prepare` that appends leaves behind when its command ends idempotent or loses a race", () => {
  it("the same withdrawal three times at once on a fresh wallet", { timeout: 120_000 }, async () => {
    const ids = wallets(40);
    for (const id of ids) await openWallet(id);
    for (const id of ids) {
      const withdrawalId = crypto.randomUUID();
      const exits = await Promise.all([1, 2, 3].map(() => run(Withdraw, { withdrawalId, walletId: id, amount: 1, description: "race" })));
      for (const e of exits) assert.ok(okOrConflict(e), String(e));
    }
    const withdrawals = (await probe.query<{ n: number }>(`SELECT count(*)::int AS n FROM crablet_events WHERE type = 'WithdrawalMade' AND data->>'walletId' = ANY($1)`, [ids])).rows[0]!.n;
    assert.strictEqual(withdrawals, ids.length, "one withdrawal per wallet");
    assert.deepStrictEqual((await countOf("WalletStatementOpened", ids)).filter((r) => r.n !== 1), [], "one opening per wallet");
    assert.deepStrictEqual(await eventsWithNoCommand(), [], "no event without an audit row");
  });

  it("transfers in both directions at once between two fresh wallets", { timeout: 120_000 }, async () => {
    const pairs = Array.from({ length: 8 }, () => [wallets(1)[0]!, wallets(1)[0]!] as const);
    for (const [a, b] of pairs) { await openWallet(a); await openWallet(b); }
    for (const [a, b] of pairs) {
      const exits = await Promise.all([
        run(TransferMoney, { transferId: crypto.randomUUID(), fromWalletId: a, toWalletId: b, amount: 1, description: "ab" }),
        run(TransferMoney, { transferId: crypto.randomUUID(), fromWalletId: b, toWalletId: a, amount: 1, description: "ba" }),
        run(TransferMoney, { transferId: crypto.randomUUID(), fromWalletId: a, toWalletId: b, amount: 1, description: "ab2" })
      ]);
      for (const e of exits) assert.ok(okOrConflict(e), String(e));
    }
    const ids = pairs.flat();
    assert.deepStrictEqual((await countOf("WalletStatementOpened", ids)).filter((r) => r.n !== 1), [], "one opening per wallet");
    assert.deepStrictEqual(await eventsWithNoCommand(), [], "no event without an audit row");
  });

  it("the month rollover: the same deposit three times at once, the first command of the next month closes the old statement and opens the new one", { timeout: 120_000 }, async () => {
    // Same steps as Deposit, but its `prepare` runs one month later than the wall clock, so the wallet's open statement is the old one.
    const next = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth() + 1, 15));
    const LaterDeposit = defineCommand({
      name: "later_deposit",
      input: Schema.Struct({ depositId: Schema.String, walletId: Schema.String, amount: Schema.Number }),
      errors: [],
      prepare: (c: any, es: any) => resolveActivePeriod(es, c.walletId, next),
      model: (c: any, period: any) => WalletModel.of({ id: c.walletId, year: period.year, month: period.month }),
      consistency: (c: any) => concurrent({ guard: WalletModel.lifecycleQuery(c.walletId) }),
      idempotentBy: (c: any) => DepositMade.where({ [WalletTags.DEPOSIT_ID]: c.depositId }),
      decide: (_w: any, c: any, period: any) => emit(DepositMade({ depositId: c.depositId, walletId: c.walletId, amount: c.amount, newBalance: 0, depositedAt: next.toISOString(), description: "later" } as never, periodTags(period)))
    } as never);
    const ids = wallets(30);
    for (const id of ids) { await openWallet(id); await run(Deposit, { depositId: crypto.randomUUID(), walletId: id, amount: 1, description: "this month" }); }
    for (const id of ids) {
      const depositId = crypto.randomUUID();
      const exits = await Promise.all([1, 2, 3].map(() => run(LaterDeposit, { depositId, walletId: id, amount: 2 })));
      for (const e of exits) assert.ok(okOrConflict(e), String(e));
    }
    const closed = await countOf("WalletStatementClosed", ids);
    assert.deepStrictEqual(closed.filter((r) => r.n !== 1), [], "one closing per wallet");
    assert.strictEqual(closed.length, ids.length);
    const opened = await countOf("WalletStatementOpened", ids);
    assert.deepStrictEqual(opened.filter((r) => r.n !== 2), [], "two openings per wallet: this month's and next month's");
    assert.deepStrictEqual(await eventsWithNoCommand(), [], "no event without an audit row");
  });
});
