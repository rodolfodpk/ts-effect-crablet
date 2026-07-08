// Runs under Node (Testcontainers) - see NOTES.md. Postgres-backed unit tests for
// WalletBalanceViewProjector/WalletTransactionViewProjector/WalletSummaryViewProjector, driven
// directly (hand-built StoredEvent fixtures), same style as statement-view.test.ts.
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { Effect, Layer, ManagedRuntime, Redacted } from "effect";
import { SqlClient } from "@effect/sql";
import { PgClient } from "@effect/sql-pg";
import type { StoredEvent } from "@crablet/eventstore";
import type { Tag } from "@crablet/eventstore/Tag";
import { startTestDb, type TestDb } from "@crablet/test-support";
import { makeWalletBalanceViewProjector } from "../src/views/WalletBalanceViewProjector.ts";
import { makeWalletTransactionViewProjector } from "../src/views/WalletTransactionViewProjector.ts";
import { makeWalletSummaryViewProjector } from "../src/views/WalletSummaryViewProjector.ts";
import * as WalletEvents from "../src/domain/events/WalletEvents.ts";
import { applyAppMigrations } from "./support/applyAppMigrations.ts";

let db: TestDb;
let runtime: ManagedRuntime.ManagedRuntime<SqlClient.SqlClient | PgClient.PgClient, never>;

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
  runtime = ManagedRuntime.make(pgLayer as unknown as Layer.Layer<SqlClient.SqlClient | PgClient.PgClient, never>);
}, { timeout: 60_000 });

after(async () => {
  await runtime.dispose();
  await db.stop();
});

const run = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient | PgClient.PgClient>) => runtime.runPromise(effect);

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

describe("WalletBalanceViewProjector / WalletTransactionViewProjector / WalletSummaryViewProjector (real Postgres)", () => {
  it("balance view: opens, deposits, withdraws, transfers, then closes (row deleted)", async () => {
    const fromWalletId = `wallet-${crypto.randomUUID()}`;
    const toWalletId = `wallet-${crypto.randomUUID()}`;

    await run(
      Effect.gen(function* () {
        const projector = yield* makeWalletBalanceViewProjector();
        yield* projector.handle([
          fakeEvent(WalletEvents.WALLET_OPENED, { wallet_id: fromWalletId }, { walletId: fromWalletId, owner: "Alice", initialBalance: 100, openedAt: new Date().toISOString() }),
          fakeEvent(WalletEvents.WALLET_OPENED, { wallet_id: toWalletId }, { walletId: toWalletId, owner: "Bob", initialBalance: 0, openedAt: new Date().toISOString() })
        ]);
        yield* projector.handle([
          fakeEvent(
            WalletEvents.MONEY_TRANSFERRED,
            { from_wallet_id: fromWalletId, to_wallet_id: toWalletId },
            { transferId: "t1", fromWalletId, toWalletId, amount: 30, fromBalance: 70, toBalance: 30, transferredAt: new Date().toISOString(), description: "x" }
          )
        ]);
      })
    );

    const rows = await run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        return yield* sql.unsafe<{ wallet_id: string; balance: string }>(
          "SELECT wallet_id, balance FROM wallet_balance_view WHERE wallet_id IN ($1, $2)",
          [fromWalletId, toWalletId]
        );
      })
    );
    const byWallet = Object.fromEntries(rows.map((r) => [r.wallet_id, Number(r.balance)]));
    assert.strictEqual(byWallet[fromWalletId], 70);
    assert.strictEqual(byWallet[toWalletId], 30);

    await run(
      Effect.gen(function* () {
        const projector = yield* makeWalletBalanceViewProjector();
        yield* projector.handle([fakeEvent(WalletEvents.WALLET_CLOSED, { wallet_id: fromWalletId }, { walletId: fromWalletId, closedAt: new Date().toISOString() })]);
      })
    );
    const afterClose = await run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        return yield* sql.unsafe("SELECT wallet_id FROM wallet_balance_view WHERE wallet_id = $1", [fromWalletId]);
      })
    );
    assert.strictEqual(afterClose.length, 0, "expected the row to be deleted on WalletClosed");
  });

  it("transaction view: one row per deposit/withdrawal, two rows per transfer", async () => {
    const walletId = `wallet-${crypto.randomUUID()}`;
    const otherWalletId = `wallet-${crypto.randomUUID()}`;
    const transferId = crypto.randomUUID();

    await run(
      Effect.gen(function* () {
        const projector = yield* makeWalletTransactionViewProjector();
        yield* projector.handle([
          fakeEvent(WalletEvents.DEPOSIT_MADE, { wallet_id: walletId }, { depositId: "d1", walletId, amount: 20, newBalance: 20, depositedAt: new Date().toISOString(), description: "x" }),
          fakeEvent(
            WalletEvents.MONEY_TRANSFERRED,
            { from_wallet_id: walletId, to_wallet_id: otherWalletId },
            { transferId, fromWalletId: walletId, toWalletId: otherWalletId, amount: 5, fromBalance: 15, toBalance: 5, transferredAt: new Date().toISOString(), description: "x" }
          )
        ]);
      })
    );

    const rows = await run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        return yield* sql.unsafe<{ transaction_id: string; wallet_id: string; amount: string }>(
          "SELECT transaction_id, wallet_id, amount FROM wallet_transaction_view WHERE wallet_id IN ($1, $2)",
          [walletId, otherWalletId]
        );
      })
    );
    assert.strictEqual(rows.length, 3);
    assert.deepStrictEqual(
      new Set(rows.map((r) => r.transaction_id)),
      new Set(["d1", `${transferId}-from`, `${transferId}-to`])
    );
  });

  it("summary view: running totals increment, current_balance is set, GREATEST guards last_transaction_at", async () => {
    const walletId = `wallet-${crypto.randomUUID()}`;
    await run(
      Effect.gen(function* () {
        const projector = yield* makeWalletSummaryViewProjector();
        yield* projector.handle([
          fakeEvent(WalletEvents.WALLET_OPENED, { wallet_id: walletId }, { walletId, owner: "Alice", initialBalance: 0, openedAt: new Date().toISOString() })
        ]);
        yield* projector.handle([
          fakeEvent(WalletEvents.DEPOSIT_MADE, { wallet_id: walletId }, { depositId: "d1", walletId, amount: 50, newBalance: 50, depositedAt: new Date().toISOString(), description: "x" })
        ]);
        yield* projector.handle([
          fakeEvent(WalletEvents.WITHDRAWAL_MADE, { wallet_id: walletId }, { withdrawalId: "w1", walletId, amount: 10, newBalance: 40, withdrawnAt: new Date().toISOString(), description: "x" })
        ]);
      })
    );

    const row = await run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const rows = yield* sql.unsafe<{ total_deposits: string; total_withdrawals: string; current_balance: string }>(
          "SELECT total_deposits, total_withdrawals, current_balance FROM wallet_summary_view WHERE wallet_id = $1",
          [walletId]
        );
        return rows[0]!;
      })
    );
    assert.strictEqual(Number(row.total_deposits), 50);
    assert.strictEqual(Number(row.total_withdrawals), 10);
    assert.strictEqual(Number(row.current_balance), 40);
  });
});
