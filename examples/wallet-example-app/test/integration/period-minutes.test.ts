// Runs under Node (Testcontainers). The statement period of N minutes (WALLET_PERIOD=minutes:5, src/domain/WalletPeriod.ts) on a real Postgres: a turn closes the slot and opens the next one with the balance carried,
// a command that decided in a slot that closed before it appended conflicts and retries into the open one, and the statement view holds the closed and the open statement.
//
// The period model is read when WalletModel.ts is loaded, so the variable is set first and the wallet's modules are imported after it (static imports are hoisted, these are not). `node --test` runs each file in its own
// process, so the setting does not reach the other integration tests.
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { Deferred, Effect, Exit, Layer, ManagedRuntime, Redacted } from "effect";
import { SqlClient } from "effect/sql";
import { PgClient } from "@effect/sql-pg";
import { Client } from "pg";
import { EventStore, makeEventStoreLayer, type StoredEvent } from "@crablet/eventstore";
import { CommandAuditStoreLive } from "@crablet/eventstore/CommandAuditStore";
import { CommandExecutor, CommandExecutorLive } from "@crablet/commands";
import { startTestDb, type TestDb } from "@crablet/test-support";
import { applyAppMigrations } from "../support/applyAppMigrations.ts";

process.env["WALLET_PERIOD"] = "minutes:5";

let db: TestDb;
let runtime: ManagedRuntime.ManagedRuntime<CommandExecutor | EventStore | SqlClient.SqlClient, never>;
let probe: Client;
// the wallet's modules, imported after the variable is set
let m: {
  Deposit: any; Withdraw: any; OpenWallet: any; WalletPeriodModel: any; WalletStatementView: any;
  atClock: any; pausableDeposit: any;
};
before(async () => {
  m = {
    Deposit: (await import("../../src/domain/commands/DepositCommand.ts")).Deposit,
    Withdraw: (await import("../../src/domain/commands/WithdrawCommand.ts")).Withdraw,
    OpenWallet: (await import("../../src/domain/commands/OpenWalletCommand.ts")).OpenWallet,
    WalletPeriodModel: (await import("../../src/domain/WalletModel.ts")).WalletPeriodModel,
    WalletStatementView: (await import("../../src/views/WalletStatementViewProjector.ts")).WalletStatementView,
    atClock: (await import("../support/clocked-commands.ts")).atClock,
    pausableDeposit: (await import("../support/clocked-commands.ts")).pausableDeposit
  };
  db = await startTestDb();
  await applyAppMigrations(db.connInfo);
  runtime = ManagedRuntime.make(
    Layer.provideMerge(
      Layer.mergeAll(CommandExecutorLive, makeEventStoreLayer({ wakeupMode: "off" }), CommandAuditStoreLive),
      PgClient.layer({ host: db.connInfo.host, port: db.connInfo.port, database: db.connInfo.database, username: db.connInfo.username, password: Redacted.make(db.connInfo.password), maxConnections: 20 })
    ) as never
  ) as never;
  probe = new Client({ host: db.connInfo.host, port: db.connInfo.port, database: db.connInfo.database, user: db.connInfo.username, password: db.connInfo.password });
  await probe.connect();
}, { timeout: 60_000 });
after(async () => { await probe.end(); await runtime.dispose(); await db.stop(); });

// two consecutive 5-minute slots (the slots are aligned to the epoch, so 12:00 starts one)
const slotA = new Date(Date.UTC(2026, 9, 11, 12, 1));
const slotB = new Date(Date.UTC(2026, 9, 11, 12, 6));
const bucketOf = (d: Date) => Math.floor(d.getTime() / 300_000);

const exec = <A>(effect: Effect.Effect<A, unknown, any>) => runtime.runPromise(Effect.exit(effect as never)) as Promise<Exit.Exit<unknown, unknown>>;
const runAt = (now: () => Date, command: any, input: unknown) => exec(m.atClock(now, Effect.flatMap(CommandExecutor, (ex) => (ex as any).run(command, input))));
// the wallet's balance in the period open at `at`
const balance = (id: string, at: Date) =>
  runtime.runPromise(m.atClock(() => at, Effect.flatMap(EventStore, (es) => m.WalletPeriodModel.of({ id }).load(es))) as never).then((r: any) => r.state.balance as number);
const newWallet = () => `w-${crypto.randomUUID()}`;
const open = (id: string) => runAt(() => slotA, m.OpenWallet, { walletId: id, owner: "x", initialBalance: 100 });
const dep = (walletId: string, amount: number, depositId = crypto.randomUUID()) => ({ depositId, walletId, amount, description: "" });
const ok = (e: Exit.Exit<unknown, unknown>) => Exit.isSuccess(e);

// A wallet whose slot A statement is open, with 10 deposited: 110.
const warmWallet = async () => {
  const id = newWallet();
  await open(id);
  assert.ok(ok(await runAt(() => slotA, m.Deposit, dep(id, 10))));
  return id;
};
const eventsOf = async (id: string, type: string) =>
  (await probe.query<{ data: Record<string, any>; tags: string[]; position: string }>(`SELECT data, tags, position::text FROM crablet_events WHERE type = $2 AND tags @> ARRAY['wallet_id=' || $1]::text[] ORDER BY position`, [id, type])).rows;

// Pauses the FIRST attempt of a command after its model is loaded; later attempts run straight through. The paused command reads slot A until it is released and slot B after.
const pausedOnce = async () => {
  const [reached, resume] = (await runtime.runPromise(Effect.all([Deferred.make<void>(), Deferred.make<void>()]) as never)) as [Deferred.Deferred<void>, Deferred.Deferred<void>];
  const state = { calls: 0, released: false };
  const pause = Effect.suspend(() => (state.calls++ === 0 ? Effect.andThen(Deferred.succeed(reached, undefined), Deferred.await(resume)) : Effect.void));
  return {
    pause,
    clock: () => (state.released ? slotB : slotA),
    reached: () => runtime.runPromise(Deferred.await(reached) as never),
    release: () => { state.released = true; return runtime.runPromise(Deferred.succeed(resume, undefined) as never); }
  };
};

describe("a statement period of 5 minutes, on Postgres", () => {
  it("the first command of the next slot closes the slot and opens the next one with the balance carried, tagged by year and bucket", { timeout: 60_000 }, async () => {
    const id = await warmWallet(); // 110 in slot A
    assert.ok(ok(await runAt(() => slotB, m.Deposit, dep(id, 5))));
    const closed = await eventsOf(id, "WalletStatementClosed");
    const opened = await eventsOf(id, "WalletStatementOpened");
    assert.strictEqual(closed.length, 1);
    assert.strictEqual(opened.length, 2, "slot A and slot B");
    assert.strictEqual(closed[0]!.data["closingBalance"], 110);
    assert.strictEqual(opened[1]!.data["openingBalance"], 110, "the balance is carried into slot B");
    assert.ok(closed[0]!.tags.includes(`bucket=${bucketOf(slotA)}`) && closed[0]!.tags.includes("year=2026"), `closing tags: ${closed[0]!.tags}`);
    assert.ok(opened[1]!.tags.includes(`bucket=${bucketOf(slotB)}`));
    assert.ok(!opened[1]!.tags.some((tag) => tag.startsWith("month=")), "no month tag in minutes mode");
    assert.strictEqual(await balance(id, slotB), 115);
  });

  it("a command that decided in slot A, paused while the slot turns, conflicts and ends well in slot B; nothing is written into slot A after its closing", { timeout: 60_000 }, async () => {
    const id = await warmWallet();
    const p = await pausedOnce();
    const late = m.pausableDeposit(p.pause);
    const aRun = runAt(p.clock, late, dep(id, 7));
    await p.reached();
    assert.ok(ok(await runAt(() => slotB, m.Deposit, dep(id, 5)))); // the slot turns: closes A (110), opens B (110), deposits 5
    await p.release();
    assert.ok(ok(await aRun), "the late deposit ends well (after a retry)");
    assert.strictEqual(await balance(id, slotB), 100 + 10 + 5 + 7, "the open slot holds everything");
    const lateInA = (await probe.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM crablet_events e
        WHERE e.type = 'DepositMade' AND e.tags @> ARRAY['wallet_id=' || $1, 'bucket=' || $2]::text[]
          AND e.position > COALESCE((SELECT max(c.position) FROM crablet_events c WHERE c.type = 'WalletStatementClosed' AND c.tags @> ARRAY['wallet_id=' || $1, 'bucket=' || $2]::text[]), 9223372036854775807)`,
      [id, String(bucketOf(slotA))]
    )).rows[0]!.n;
    assert.strictEqual(lateInA, 0);
  });

  it("four deposits of different amounts at once on 30 wallets whose slot just turned: right balances, one closing, two openings each", { timeout: 120_000 }, async () => {
    const ids: string[] = [];
    for (let i = 0; i < 30; i++) ids.push(await warmWallet());
    const amounts = [1, 2, 4, 8];
    for (const id of ids) await Promise.all(amounts.map((x) => runAt(() => slotB, m.Deposit, dep(id, x))));
    const sum = amounts.reduce((p, q) => p + q, 0);
    assert.deepStrictEqual((await Promise.all(ids.map((id) => balance(id, slotB)))).filter((b) => b !== 110 + sum), []);
    const per = (type: string) => probe.query<{ n: number }>(`SELECT count(*)::int AS n FROM crablet_events WHERE type = $2 AND data->>'walletId' = ANY($1) GROUP BY data->>'walletId'`, [ids, type]).then((r) => r.rows.map((x) => x.n));
    assert.deepStrictEqual((await per("WalletStatementClosed")).filter((n) => n !== 1), []);
    assert.deepStrictEqual((await per("WalletStatementOpened")).filter((n) => n !== 2), []);
  });

  it("a pod whose clock is still in slot A never turns the period back", { timeout: 60_000 }, async () => {
    const id = await warmWallet();
    assert.ok(ok(await runAt(() => slotB, m.Deposit, dep(id, 5))));
    assert.ok(ok(await runAt(() => slotA, m.Deposit, dep(id, 7)))); // a pod that still believes it is slot A
    assert.strictEqual(await balance(id, slotB), 100 + 10 + 5 + 7);
    assert.strictEqual((await eventsOf(id, "WalletStatementOpened")).length, 2, "slot A was not opened a second time");
  });

  it("a withdrawal that the domain refuses writes nothing of the turn", { timeout: 60_000 }, async () => {
    const id = await warmWallet();
    const before = (await probe.query<{ n: number }>(`SELECT count(*)::int AS n FROM crablet_events WHERE tags @> ARRAY['wallet_id=' || $1]::text[]`, [id])).rows[0]!.n;
    assert.ok(!ok(await runAt(() => slotB, m.Withdraw, { withdrawalId: crypto.randomUUID(), walletId: id, amount: 1_000_000, description: "" })));
    const after = (await probe.query<{ n: number }>(`SELECT count(*)::int AS n FROM crablet_events WHERE tags @> ARRAY['wallet_id=' || $1]::text[]`, [id])).rows[0]!.n;
    assert.strictEqual(after, before);
  });

  it("the statement view holds the closed statement (closing balance, month NULL) and the open one (opening balance carried)", { timeout: 60_000 }, async () => {
    const id = await warmWallet();
    assert.ok(ok(await runAt(() => slotB, m.Deposit, dep(id, 5))));
    // the events of this wallet, as the views processor would hand them to the projector
    const rows = (await probe.query<{ type: string; tags: string[]; data: unknown; transaction_id: string; position: string; occurred_at: Date }>(
      `SELECT type, tags, data, transaction_id::text, position::text, occurred_at FROM crablet_events WHERE tags @> ARRAY['wallet_id=' || $1]::text[] ORDER BY transaction_id, position`, [id])).rows;
    const stored: StoredEvent[] = rows.map((r) => ({
      eventId: crypto.randomUUID(),
      type: r.type,
      tags: r.tags.map((t) => { const i = t.indexOf("="); return { key: t.slice(0, i), value: t.slice(i + 1) }; }),
      data: r.data, transactionId: r.transaction_id, position: BigInt(r.position), occurredAt: r.occurred_at, correlationId: null, causationId: null
    }));
    await runtime.runPromise(Effect.gen(function* () {
      const projector = yield* m.WalletStatementView.projector;
      yield* projector.handle(stored);
    }) as never);
    const view = (await probe.query<{ statement_id: string; month: number | null; year: number; opening_balance: string; closing_balance: string | null; closed_at: Date | null; total_deposits: string }>(
      `SELECT * FROM wallet_statement_view WHERE wallet_id = $1 ORDER BY opened_at, statement_id`, [id])).rows;
    assert.strictEqual(view.length, 2);
    const closedRow = view.find((r) => r.closing_balance !== null)!;
    const openRow = view.find((r) => r.closing_balance === null)!;
    assert.strictEqual(Number(closedRow.closing_balance), 110);
    assert.ok(closedRow.closed_at !== null);
    assert.strictEqual(closedRow.month, null, "no month in minutes mode");
    assert.strictEqual(closedRow.year, 2026);
    assert.strictEqual(Number(openRow.opening_balance), 110, "carried");
    assert.strictEqual(Number(openRow.total_deposits), 5);
    assert.ok(closedRow.statement_id.endsWith(`m${bucketOf(slotA)}`) && openRow.statement_id.endsWith(`m${bucketOf(slotB)}`), `${closedRow.statement_id}, ${openRow.statement_id}`);
  });
});
