// Runs under Node (Testcontainers). The wallet's four views are declared with defineView (ADR-0026): the declared tables must match the migrated database, and the SQL their operations compile to must leave
// the rows the in-memory run says it should, for a history with a deposit, a withdrawal, a transfer, a statement opened and closed and a closed wallet.
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { Effect, Layer, ManagedRuntime, Redacted } from "effect";
import { SqlClient } from "effect/sql";
import { PgClient } from "@effect/sql-pg";
import type { StoredEvent } from "@crablet/eventstore";
import type { Tag } from "@crablet/eventstore/Tag";
import { startTestDb, type TestDb } from "@crablet/test-support";
import { applyInMemory, normalizeRow, rowsOf } from "@crablet/views/ViewMemory";
import type { ProjectedView } from "@crablet/views/ProjectedView";
import { checkViewTables } from "@crablet/views/ViewTableCheck";
import type { ViewTableDef } from "@crablet/views/ViewTable";
import { WalletBalanceView, walletBalanceTable } from "../../src/views/WalletBalanceViewProjector.ts";
import { WalletSummaryView, walletSummaryTable } from "../../src/views/WalletSummaryViewProjector.ts";
import { WalletTransactionView, walletTransactionTable } from "../../src/views/WalletTransactionViewProjector.ts";
import { WalletStatementView, walletStatementTable } from "../../src/views/WalletStatementViewProjector.ts";
import * as WalletEvents from "../../src/domain/events/WalletEvents.ts";
import { applyAppMigrations } from "../support/applyAppMigrations.ts";

type Env = SqlClient.SqlClient | PgClient.PgClient;
let db: TestDb;
let runtime: ManagedRuntime.ManagedRuntime<Env, never>;

before(async () => {
  db = await startTestDb();
  await applyAppMigrations(db.connInfo);
  const pgLayer = PgClient.layer({
    host: db.connInfo.host,
    port: db.connInfo.port,
    database: db.connInfo.database,
    username: db.connInfo.username,
    password: Redacted.make(db.connInfo.password)
  });
  runtime = ManagedRuntime.make(pgLayer as unknown as Layer.Layer<Env, never>);
}, { timeout: 60_000 });

after(async () => {
  await runtime.dispose();
  await db.stop();
});

const run = <A, E>(effect: Effect.Effect<A, E, Env>) => runtime.runPromise(effect);

let nextPosition = 1n;
const fakeEvent = (type: string, tags: Record<string, string>, data: unknown): StoredEvent => ({
  type,
  tags: Object.entries(tags).map(([key, value]): Tag => ({ key, value })),
  data,
  transactionId: "1",
  position: nextPosition++,
  occurredAt: new Date(),
  correlationId: null,
  causationId: null
});

const t = (n: number) => new Date(Date.UTC(2026, 6, 1, 12, n)).toISOString();
const A = "wallet-a";
const B = "wallet-b";
const SA = "wallet:wallet-a:2026-07";
const SB = "wallet:wallet-b:2026-07";

const history = (): ReadonlyArray<StoredEvent> => [
  fakeEvent(WalletEvents.WALLET_OPENED, { wallet_id: A }, { walletId: A, owner: "Alice", initialBalance: 100, openedAt: t(0) }),
  fakeEvent(WalletEvents.WALLET_OPENED, { wallet_id: B }, { walletId: B, owner: "Bob", initialBalance: 0, openedAt: t(0) }),
  fakeEvent(WalletEvents.WALLET_STATEMENT_OPENED, { wallet_id: A, statement_id: SA }, { walletId: A, statementId: SA, year: 2026, month: 7, openingBalance: 100, openedAt: t(0) }),
  fakeEvent(WalletEvents.WALLET_STATEMENT_OPENED, { wallet_id: B, statement_id: SB }, { walletId: B, statementId: SB, year: 2026, month: 7, openingBalance: 0, openedAt: t(0) }),
  fakeEvent(WalletEvents.DEPOSIT_MADE, { wallet_id: A, deposit_id: "d1", statement_id: SA }, { depositId: "d1", walletId: A, amount: 50, newBalance: 150, depositedAt: t(5), description: "pay" }),
  // concurrent with d1: records a STALE newBalance (130), the views must still add 30
  fakeEvent(WalletEvents.DEPOSIT_MADE, { wallet_id: A, deposit_id: "d2", statement_id: SA }, { depositId: "d2", walletId: A, amount: 30, newBalance: 130, depositedAt: t(4), description: "late" }),
  fakeEvent(WalletEvents.WITHDRAWAL_MADE, { wallet_id: A, withdrawal_id: "w1", statement_id: SA }, { withdrawalId: "w1", walletId: A, amount: 20, newBalance: 160, withdrawnAt: t(6), description: "rent" }),
  fakeEvent(
    WalletEvents.MONEY_TRANSFERRED,
    { transfer_id: "x1", from_wallet_id: A, to_wallet_id: B, from_statement_id: SA, to_statement_id: SB },
    { transferId: "x1", fromWalletId: A, toWalletId: B, amount: 40, fromBalance: 120, toBalance: 40, transferredAt: t(7), description: "gift" }
  ),
  fakeEvent(WalletEvents.DEPOSIT_MADE, { wallet_id: B, deposit_id: "d3" }, { depositId: "d3", walletId: B, amount: 5, newBalance: 45, depositedAt: t(8), description: "no statement" }), // no statement tag: skipped by the statement view
  fakeEvent(WalletEvents.WALLET_STATEMENT_CLOSED, { wallet_id: A, statement_id: SA }, { walletId: A, statementId: SA, year: 2026, month: 7, openingBalance: 100, closingBalance: 160, closedAt: t(9) }),
  fakeEvent(WalletEvents.WALLET_CLOSED, { wallet_id: B }, { walletId: B, closedAt: t(10) })
];

const views: ReadonlyArray<readonly [ProjectedView, ViewTableDef, string]> = [
  [WalletBalanceView, walletBalanceTable, "wallet_id"],
  [WalletSummaryView, walletSummaryTable, "wallet_id"],
  [WalletTransactionView, walletTransactionTable, "transaction_id"],
  [WalletStatementView, walletStatementTable, "statement_id"]
];

describe("the wallet's declared views (real Postgres)", () => {
  it("the declared tables match the migrated database", async () => {
    const problems = await run(Effect.flatMap(SqlClient.SqlClient, (sql) => checkViewTables(sql, views.map(([, table]) => table))));
    assert.deepStrictEqual(problems, []);
  });

  for (const [view, table, order] of views) {
    it(`${view.name}: the SQL leaves the rows the in-memory run says it should`, async () => {
      const events = history();
      const memory = await run(applyInMemory(view, events));
      await run(Effect.flatMap(view.projector, (projector) => projector.handle(events)));
      const rows = await run(
        Effect.flatMap(SqlClient.SqlClient, (sql) => sql.unsafe<Record<string, unknown>>(`SELECT * FROM ${table.name} ORDER BY ${order}`))
      );
      const expected = rowsOf(memory, table).slice().sort((x, y) => String(x[order]).localeCompare(String(y[order])));
      assert.deepStrictEqual(rows.map((r) => normalizeRow(table, r)), expected);
      assert.ok(expected.length > 0, "the history leaves rows to compare");
    });
  }

  it("and the rows are what the history means (a stale newBalance changes nothing; the statement adds up)", async () => {
    const rows = await run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        return {
          balance: yield* sql.unsafe<{ wallet_id: string; balance: string }>("SELECT wallet_id, balance FROM wallet_balance_view ORDER BY wallet_id"),
          summary: yield* sql.unsafe<Record<string, unknown>>("SELECT * FROM wallet_summary_view WHERE wallet_id = $1", [A]),
          statement: yield* sql.unsafe<Record<string, unknown>>("SELECT * FROM wallet_statement_view WHERE statement_id = $1", [SA])
        };
      })
    );
    // A: 100 + 50 + 30 - 20 - 40 = 120; B was closed, so its row is gone.
    assert.deepStrictEqual(rows.balance.map((r) => [r.wallet_id, Number(r.balance)]), [[A, 120]]);
    const sum = rows.summary[0]!;
    assert.deepStrictEqual(
      [sum["total_deposits"], sum["total_withdrawals"], sum["total_transfers_out"], sum["current_balance"]].map(Number),
      [80, 20, 40, 120]
    );
    const s = rows.statement[0]!;
    assert.deepStrictEqual(
      [s["total_deposits"], s["total_withdrawals"], s["total_transfers_out"], s["transaction_count"], s["closing_balance"]].map(Number),
      [80, 20, 40, 4, 160]
    );
  });
});
