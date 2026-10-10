// Runs under Node (Testcontainers). Regression tests for the month rollover, the acceptance tests of docs/plans/period-rollover.md. A wallet's statement period is decided from the clock in a command's `prepare`;
// when the month turns, the first command of the new month closes the old statement and opens the next. The tests below turn the month while another command is already under way, and check that no money is
// lost: the wallet's balance in the CURRENT period must equal what was put in and taken out, and nothing may be written into a period after it was closed.
//
// Before `.period` these failed (measured: a deposit that decided on the old month and appended after it closed ended with 115 in the current period instead of 122; NOTES.md, "Closed periods"). The framework now
// turns the period in the command's own append and puts the closing of the period a command decided in into its boundary. The window between a `prepare` that resolved the period and the model load, which the first
// version of these tests also paused in, no longer exists: there is no `prepare`.
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { Deferred, Effect, Exit, Layer, ManagedRuntime, Redacted } from "effect";
import { PgClient } from "@effect/sql-pg";
import { Client } from "pg";
import { EventStore, makeEventStoreLayer } from "@crablet/eventstore";
import { CommandAuditStoreLive } from "@crablet/eventstore/CommandAuditStore";
import { CommandExecutor, CommandExecutorLive } from "@crablet/commands";
import { startTestDb, type TestDb } from "@crablet/test-support";
import { applyAppMigrations } from "../support/applyAppMigrations.ts";
import { atClock, pausableDeposit, pausableTransfer, pausableWithdraw } from "../support/clocked-commands.ts";
import { Deposit } from "../../src/domain/commands/DepositCommand.ts";
import { Withdraw } from "../../src/domain/commands/WithdrawCommand.ts";
import { OpenWallet } from "../../src/domain/commands/OpenWalletCommand.ts";
import { WalletModel, WalletStatementOpened } from "../../src/domain/WalletModel.ts";

// The tests move the Effect clock to other months. The wake-up window (EventStoreConfig.wakeupMode) measures time with that same clock, and a clock in the future makes it schedule a timer for days that keeps the
// process alive: wake-ups are off here, nothing listens for them.
let db: TestDb;
let runtime: ManagedRuntime.ManagedRuntime<CommandExecutor | EventStore, never>;
let probe: Client;
before(async () => {
  db = await startTestDb();
  await applyAppMigrations(db.connInfo);
  runtime = ManagedRuntime.make(
    Layer.provideMerge(
      Layer.mergeAll(CommandExecutorLive, makeEventStoreLayer({ wakeupMode: "off" }), CommandAuditStoreLive),
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

const exec = <A>(effect: Effect.Effect<A, unknown, any>) => runtime.runPromise(Effect.exit(effect as never)) as Promise<Exit.Exit<unknown, unknown>>;
// Runs a command with the clock reading `now()`.
const runAt = (now: () => Date, command: any, input: unknown) => exec(atClock(now, Effect.flatMap(CommandExecutor, (ex) => (ex as any).run(command, input))));
const balance = (id: string, d: Date) => runtime.runPromise(Effect.flatMap(EventStore, (es) => WalletModel.of({ id, ...ym(d) }).load(es)) as never).then((r: any) => r.state.balance as number);
const newWallet = () => `w-${crypto.randomUUID()}`;
const open = (id: string) => runAt(() => thisMonth, OpenWallet, { walletId: id, owner: "x", initialBalance: 100 });
const dep = (walletId: string, amount: number, depositId = crypto.randomUUID()) => ({ depositId, walletId, amount, description: "" });
const wd = (walletId: string, amount: number) => ({ withdrawalId: crypto.randomUUID(), walletId, amount, description: "" });
const ok = (e: Exit.Exit<unknown, unknown>) => Exit.isSuccess(e);

// A wallet with this month's statement open and 10 deposited: 110 in this month.
const warmWallet = async () => {
  const id = newWallet();
  await open(id);
  assert.ok(ok(await runAt(() => thisMonth, Deposit, dep(id, 10))));
  return id;
};

// Pauses the FIRST attempt of a command after its model is loaded; later attempts (after a conflict) run straight through. The paused command reads "this month" until it is released and "next month" after:
// by then the month has turned.
const pausedOnce = async () => {
  const [reached, resume] = (await runtime.runPromise(Effect.all([Deferred.make<void>(), Deferred.make<void>()]) as never)) as [Deferred.Deferred<void>, Deferred.Deferred<void>];
  const state = { calls: 0, released: false };
  const pause = Effect.suspend(() => (state.calls++ === 0 ? Effect.andThen(Deferred.succeed(reached, undefined), Deferred.await(resume)) : Effect.void));
  return {
    pause,
    clock: () => (state.released ? nextMonth : thisMonth),
    reached: () => runtime.runPromise(Deferred.await(reached) as never),
    release: () => { state.released = true; return runtime.runPromise(Deferred.succeed(resume, undefined) as never); }
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
const countOf = async (id: string, type: string) =>
  (await probe.query<{ n: number }>(`SELECT count(*)::int AS n FROM crablet_events WHERE type = $2 AND tags @> ARRAY['wallet_id=' || $1]::text[]`, [id, type])).rows[0]!.n;

describe("a command that decided on a month which closed before it appended", () => {
  for (const kind of ["deposit", "withdraw"] as const) {
    it(`a ${kind}, paused after the model is loaded, while the month turns`, { timeout: 60_000 }, async () => {
      const id = await warmWallet(); // 110
      const p = await pausedOnce();
      const late = kind === "deposit" ? pausableDeposit(p.pause) : pausableWithdraw(p.pause);
      const aRun = runAt(p.clock, late, kind === "deposit" ? dep(id, 7) : wd(id, 7));
      await p.reached();
      assert.ok(ok(await runAt(() => nextMonth, Deposit, dep(id, 5)))); // the month turns: closes this month (110), opens next (110), deposits 5
      await p.release();
      assert.ok(ok(await aRun), "the late command ends well (after a retry)");
      assert.strictEqual(await balance(id, nextMonth), kind === "deposit" ? 100 + 10 + 5 + 7 : 100 + 10 + 5 - 7, "the current period holds everything");
      assert.strictEqual(await writtenAfterClose(id, kind === "deposit" ? "DepositMade" : "WithdrawalMade"), 0, "nothing was written into the old month after it closed");
    });
  }

  it("a transfer, paused after the model is loaded, while one of its wallets turns the month", { timeout: 60_000 }, async () => {
    const [a, b] = [await warmWallet(), await warmWallet()]; // 110 each
    const p = await pausedOnce();
    const aRun = runAt(p.clock, pausableTransfer(p.pause), { transferId: crypto.randomUUID(), fromWalletId: a, toWalletId: b, amount: 7, description: "" });
    await p.reached();
    assert.ok(ok(await runAt(() => nextMonth, Deposit, dep(a, 5)))); // wallet A turns the month
    await p.release();
    assert.ok(ok(await aRun));
    assert.strictEqual(await balance(a, nextMonth), 100 + 10 + 5 - 7);
    assert.strictEqual(await balance(b, nextMonth), 100 + 10 + 7);
  });

  it("a statement with no transactions is closed too when the month turns, and a late writer on it conflicts", { timeout: 60_000 }, async () => {
    const id = newWallet();
    await open(id);
    // this month's statement opened and nothing done on it (what an OpenWallet that opens the first statement would leave)
    await runtime.runPromise(Effect.flatMap(EventStore, (es) => es.withWakeups(es.append([WalletStatementOpened({ walletId: id, statementId: `wallet:${id}:${ym(thisMonth).year}-${String(ym(thisMonth).month).padStart(2, "0")}`, ...ym(thisMonth), openingBalance: 100, openedAt: thisMonth.toISOString() })]))) as never);
    const p = await pausedOnce();
    const aRun = runAt(p.clock, pausableDeposit(p.pause), dep(id, 7));
    await p.reached();
    assert.ok(ok(await runAt(() => nextMonth, Deposit, dep(id, 5))));
    await p.release();
    assert.ok(ok(await aRun));
    assert.strictEqual(await balance(id, nextMonth), 100 + 5 + 7);
    assert.strictEqual(await countOf(id, "WalletStatementClosed"), 1, "the empty statement was closed");
  });
});

describe("the month turns while several commands run", () => {
  it("four deposits of different amounts at once on 60 wallets whose month just turned: right balances, one closing, two openings", { timeout: 120_000 }, async () => {
    const ids: string[] = [];
    for (let i = 0; i < 60; i++) ids.push(await warmWallet());
    const amounts = [1, 2, 4, 8];
    for (const id of ids) await Promise.all(amounts.map((x) => runAt(() => nextMonth, Deposit, dep(id, x))));
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
    const exit = await runAt(() => nextMonth, Withdraw, wd(id, 1_000_000));
    assert.ok(!ok(exit), "refused: insufficient funds");
    const after = (await probe.query<{ n: number }>(`SELECT count(*)::int AS n FROM crablet_events WHERE tags @> ARRAY['wallet_id=' || $1]::text[]`, [id])).rows[0]!.n;
    assert.strictEqual(after, before, "no closing, no opening");
  });

  it("a pod whose clock is behind never turns the period back", { timeout: 60_000 }, async () => {
    const id = await warmWallet();
    assert.ok(ok(await runAt(() => nextMonth, Deposit, dep(id, 5)))); // next month is open, this month closed
    assert.ok(ok(await runAt(() => thisMonth, Deposit, dep(id, 7)))); // a pod that still believes it is this month
    assert.strictEqual(await balance(id, nextMonth), 100 + 10 + 5 + 7, "the deposit went into the open period");
    const reopened = (await probe.query<{ n: number }>(`SELECT count(*)::int AS n FROM crablet_events WHERE type = 'WalletStatementOpened' AND tags @> ARRAY['wallet_id=' || $1, 'month=' || $2]::text[]`, [id, String(ym(thisMonth).month)])).rows[0]!.n;
    assert.strictEqual(reopened, 1, "this month's statement was not opened a second time");
  });
});
