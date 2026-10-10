// Runs under Node (Testcontainers). Regression tests for the month rollover, the acceptance tests of docs/plans/period-rollover.md. A wallet's statement period is decided from the clock in a command's `prepare`;
// when the month turns, the first command of the new month closes the old statement and opens the next. The tests below turn the month while another command is already under way, and check that no money is
// lost: the wallet's balance in the CURRENT period must equal what was put in and taken out, and nothing may be written into a period after it was closed.
//
// The ones marked `todo` fail today (measured: a deposit that decided on the old month and appended after it closed ended with 115 in the current period instead of 122). They run and report, without failing the
// suite; remove the mark when the framework closes the hole. See NOTES.md ("Closed periods").
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { Deferred, Effect, Exit, Layer, ManagedRuntime, Redacted, Ref } from "effect";
import { PgClient } from "@effect/sql-pg";
import { Client } from "pg";
import { EventStore, EventStoreLive } from "@crablet/eventstore";
import { CommandAuditStoreLive } from "@crablet/eventstore/CommandAuditStore";
import { CommandExecutor, CommandExecutorLive } from "@crablet/commands";
import { startTestDb, type TestDb } from "@crablet/test-support";
import { applyAppMigrations } from "../support/applyAppMigrations.ts";
import { clockedDeposit, clockedTransfer, clockedWithdraw, type Hooks } from "../support/clocked-commands.ts";
import { OpenWallet } from "../../src/domain/commands/OpenWalletCommand.ts";
import { WalletModel, WalletOpened, WalletStatementOpened } from "../../src/domain/WalletModel.ts";

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
after(async () => { await probe.end(); await runtime.dispose(); await db.stop(); });

const t = new Date();
const thisMonth = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), 15));
const nextMonth = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + 1, 15));
const ym = (d: Date) => ({ year: d.getUTCFullYear(), month: d.getUTCMonth() + 1 });
const todoUntilPeriod = "needs the period rollover in the framework (docs/plans/period-rollover.md)";

const exec = <A>(effect: Effect.Effect<A, unknown, any>) => runtime.runPromise(Effect.exit(effect as never)) as Promise<Exit.Exit<unknown, unknown>>;
const run = (command: any, input: unknown) => exec(Effect.flatMap(CommandExecutor, (ex) => (ex as any).run(command, input)));
const balance = (id: string, d: Date) => runtime.runPromise(Effect.flatMap(EventStore, (es) => WalletModel.of({ id, ...ym(d) }).load(es)) as never).then((r: any) => r.state.balance as number);
const newWallet = () => `w-${crypto.randomUUID()}`;
const open = (id: string) => run(OpenWallet, { walletId: id, owner: "x", initialBalance: 100 });
const dep = (walletId: string, amount: number, depositId = crypto.randomUUID()) => ({ depositId, walletId, amount, description: "" });
const ok = (e: Exit.Exit<unknown, unknown>) => Exit.isSuccess(e);

// A wallet with this month's statement open and 10 deposited: 110 in this month.
const warmWallet = async () => {
  const id = newWallet();
  await open(id);
  assert.ok(ok(await run(clockedDeposit(() => thisMonth), dep(id, 10))));
  return id;
};

// Pauses the FIRST attempt of a command at `where`; later attempts (after a conflict) run straight through. `release()` lets it go once the other command has finished.
const pausedOnce = async (where: "afterPrepare" | "afterLoad") => {
  const [reached, resume, calls] = (await runtime.runPromise(Effect.all([Deferred.make<void>(), Deferred.make<void>(), Ref.make(0)]) as never)) as [Deferred.Deferred<void>, Deferred.Deferred<void>, Ref.Ref<number>];
  const pause = Effect.flatMap(Ref.getAndUpdate(calls, (n) => n + 1), (n) => (n === 0 ? Effect.andThen(Deferred.succeed(reached, undefined), Deferred.await(resume)) : Effect.void));
  const released = { value: false };
  return {
    hooks: { [where]: pause } as Hooks,
    // the paused command reads "this month" until it is released and "next month" after: by then the month has turned (the clock is read several times per attempt, so it cannot count calls)
    clock: () => (released.value ? nextMonth : thisMonth),
    reached: () => runtime.runPromise(Deferred.await(reached) as never),
    release: () => { released.value = true; return runtime.runPromise(Deferred.succeed(resume, undefined) as never); }
  };
};

// How many events of `type` were written into the closed month after its closing event.
const writtenAfterClose = async (id: string, type: string) =>
  (await probe.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM crablet_events e
      WHERE e.type = $2 AND e.tags @> ARRAY['wallet_id=' || $1, 'month=' || $3]::text[]
        AND e.position > COALESCE((SELECT max(c.position) FROM crablet_events c WHERE c.type = 'WalletStatementClosed' AND c.tags @> ARRAY['wallet_id=' || $1, 'month=' || $3]::text[]), 9223372036854775807)`,
    [id, type, String(ym(thisMonth).month)]
  )).rows[0]!.n;

const lateWriter = (where: "afterPrepare" | "afterLoad", command: "deposit" | "withdraw") =>
  it(`a ${command} that decided on the old month, paused ${where === "afterPrepare" ? "after prepare, before the model is loaded" : "after the model is loaded, before the append"}, while the month turns`, { todo: todoUntilPeriod, timeout: 60_000 }, async () => {
    const id = await warmWallet(); // 110
    const paused = await pausedOnce(where);
    const late = command === "deposit" ? clockedDeposit(paused.clock, paused.hooks) : clockedWithdraw(paused.clock, paused.hooks);
    const input = command === "deposit" ? dep(id, 7) : { withdrawalId: crypto.randomUUID(), walletId: id, amount: 7, description: "" };
    const aRun = run(late, input);
    await paused.reached();
    assert.ok(ok(await run(clockedDeposit(() => nextMonth), dep(id, 5)))); // the month turns: closes this month (110), opens next (110), deposits 5
    await paused.release();
    assert.ok(ok(await aRun), "the late command ends well (after a retry)");
    assert.strictEqual(await balance(id, nextMonth), command === "deposit" ? 100 + 10 + 5 + 7 : 100 + 10 + 5 - 7, "the current period holds everything");
    assert.strictEqual(await writtenAfterClose(id, command === "deposit" ? "DepositMade" : "WithdrawalMade"), 0, "nothing was written into the old month after it closed");
  });

describe("a command that decided on a month which closed before it appended", () => {
  lateWriter("afterLoad", "deposit");
  lateWriter("afterPrepare", "deposit");
  lateWriter("afterLoad", "withdraw");

  it("a transfer, paused after the model is loaded, while one of its wallets turns the month", { todo: todoUntilPeriod, timeout: 60_000 }, async () => {
    const [a, b] = [await warmWallet(), await warmWallet()]; // 110 each
    const paused = await pausedOnce("afterLoad");
    const aRun = run(clockedTransfer(paused.clock, paused.hooks), { transferId: crypto.randomUUID(), fromWalletId: a, toWalletId: b, amount: 7, description: "" });
    await paused.reached();
    assert.ok(ok(await run(clockedDeposit(() => nextMonth), dep(a, 5)))); // wallet A turns the month
    await paused.release();
    assert.ok(ok(await aRun));
    assert.strictEqual(await balance(a, nextMonth), 100 + 10 + 5 - 7);
    assert.strictEqual(await balance(b, nextMonth), 100 + 10 + 7);
  });

  it("a statement with no transactions is closed too when the month turns, and a late writer on it conflicts", { todo: todoUntilPeriod, timeout: 60_000 }, async () => {
    const id = newWallet();
    await open(id);
    // this month's statement opened and nothing done on it (what an OpenWallet that opens the first statement would leave)
    await runtime.runPromise(Effect.flatMap(EventStore, (es) => es.append([WalletStatementOpened({ walletId: id, statementId: `wallet:${id}:empty`, ...ym(thisMonth), openingBalance: 100, openedAt: thisMonth.toISOString() })])) as never);
    const paused = await pausedOnce("afterLoad");
    const aRun = run(clockedDeposit(paused.clock, paused.hooks), dep(id, 7));
    await paused.reached();
    assert.ok(ok(await run(clockedDeposit(() => nextMonth), dep(id, 5))));
    await paused.release();
    assert.ok(ok(await aRun));
    assert.strictEqual(await balance(id, nextMonth), 100 + 5 + 7);
    const closed = (await probe.query<{ n: number }>(`SELECT count(*)::int AS n FROM crablet_events WHERE type = 'WalletStatementClosed' AND tags @> ARRAY['wallet_id=' || $1]::text[]`, [id])).rows[0]!.n;
    assert.strictEqual(closed, 1, "the empty statement was closed");
  });
});

describe("the month turns while several commands run", () => {
  it("four deposits of different amounts at once on 60 wallets whose month just turned: right balances, one closing, two openings", { timeout: 120_000 }, async () => {
    const ids: string[] = [];
    for (let i = 0; i < 60; i++) ids.push(await warmWallet());
    const amounts = [1, 2, 4, 8];
    for (const id of ids) await Promise.all(amounts.map((x) => run(clockedDeposit(() => nextMonth), dep(id, x))));
    const sum = amounts.reduce((p, q) => p + q, 0);
    const balances = await Promise.all(ids.map((id) => balance(id, nextMonth)));
    assert.deepStrictEqual(balances.filter((b) => b !== 100 + 10 + sum), [], "every wallet holds initial + both rounds of deposits");
    const per = (type: string) => probe.query<{ n: number }>(`SELECT count(*)::int AS n FROM crablet_events WHERE type = $2 AND data->>'walletId' = ANY($1) GROUP BY data->>'walletId'`, [ids, type]).then((r) => r.rows.map((x) => x.n));
    assert.deepStrictEqual((await per("WalletStatementClosed")).filter((n) => n !== 1), [], "one closing per wallet");
    assert.deepStrictEqual((await per("WalletStatementOpened")).filter((n) => n !== 2), [], "two openings per wallet");
  });

  it("a command the domain refuses writes nothing of the rollover", { timeout: 60_000 }, async () => {
    const id = await warmWallet();
    const before = (await probe.query<{ n: number }>(`SELECT count(*)::int AS n FROM crablet_events WHERE tags @> ARRAY['wallet_id=' || $1]::text[]`, [id])).rows[0]!.n;
    const exit = await run(clockedWithdraw(() => nextMonth), { withdrawalId: crypto.randomUUID(), walletId: id, amount: 1_000_000, description: "" });
    assert.ok(!ok(exit), "refused: insufficient funds");
    const after = (await probe.query<{ n: number }>(`SELECT count(*)::int AS n FROM crablet_events WHERE tags @> ARRAY['wallet_id=' || $1]::text[]`, [id])).rows[0]!.n;
    assert.strictEqual(after, before, "no closing, no opening");
  });

  it("a pod whose clock is behind never turns the period back", { todo: todoUntilPeriod, timeout: 60_000 }, async () => {
    const id = await warmWallet();
    assert.ok(ok(await run(clockedDeposit(() => nextMonth), dep(id, 5)))); // next month is open, this month closed
    assert.ok(ok(await run(clockedDeposit(() => thisMonth), dep(id, 7)))); // a pod that still believes it is this month
    assert.strictEqual(await balance(id, nextMonth), 100 + 10 + 5 + 7, "the deposit went into the open period");
    const reopened = (await probe.query<{ n: number }>(`SELECT count(*)::int AS n FROM crablet_events WHERE type = 'WalletStatementOpened' AND tags @> ARRAY['wallet_id=' || $1, 'month=' || $2]::text[]`, [id, String(ym(thisMonth).month)])).rows[0]!.n;
    assert.strictEqual(reopened, 1, "this month's statement was not opened a second time");
  });
});
void WalletOpened;
