// Runs under Node (Testcontainers) - see NOTES.md. Postgres-backed unit test of
// WalletStatementViewProjector specifically, driven directly (hand-built StoredEvent fixtures fed
// to projector.handle([...])), not through the full views/commands/HTTP pipeline - matches Java's
// own direct-projector-unit-test style, fidelity bar being its ~20-case suite.
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { Effect, Layer, ManagedRuntime, Redacted } from "effect";
import { SqlClient } from "@effect/sql";
import { PgClient } from "@effect/sql-pg";
import type { StoredEvent } from "@crablet/eventstore";
import type { Tag } from "@crablet/eventstore/Tag";
import { startTestDb, type TestDb } from "@crablet/test-support";
import { makeWalletStatementViewProjector } from "../src/views/WalletStatementViewProjector.ts";
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

const statementRow = (statementId: string) =>
  run(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const rows = yield* sql.unsafe<{
        opening_balance: string;
        closing_balance: string | null;
        total_deposits: string;
        total_withdrawals: string;
        total_transfers_in: string;
        total_transfers_out: string;
        transaction_count: number;
        closed_at: Date | null;
      }>("SELECT * FROM wallet_statement_view WHERE statement_id = $1", [statementId]);
      return rows[0] ?? null;
    })
  );

const handle = (events: ReadonlyArray<StoredEvent>) =>
  run(
    Effect.gen(function* () {
      const projector = yield* makeWalletStatementViewProjector();
      return yield* projector.handle(events);
    })
  );

describe("WalletStatementViewProjector (real Postgres)", () => {
  it("WalletStatementOpened creates a row with the given opening balance", async () => {
    const walletId = `wallet-${crypto.randomUUID()}`;
    const statementId = `wallet:${walletId}:2026-07`;
    const opened = fakeEvent(
      WalletEvents.WALLET_STATEMENT_OPENED,
      { wallet_id: walletId, statement_id: statementId, year: "2026", month: "7" },
      { walletId, statementId, year: 2026, month: 7, openingBalance: 100, openedAt: new Date().toISOString() }
    );
    const handled = await handle([opened]);
    assert.strictEqual(handled, 1);

    const row = await statementRow(statementId);
    assert.ok(row !== null);
    assert.strictEqual(Number(row!.opening_balance), 100);
    assert.strictEqual(row!.transaction_count, 0);
    assert.strictEqual(row!.closed_at, null);
  });

  it("DepositMade increases total_deposits and transaction_count exactly once, even if redelivered", async () => {
    const walletId = `wallet-${crypto.randomUUID()}`;
    const statementId = `wallet:${walletId}:2026-07`;
    await handle([
      fakeEvent(
        WalletEvents.WALLET_STATEMENT_OPENED,
        { wallet_id: walletId, statement_id: statementId, year: "2026", month: "7" },
        { walletId, statementId, year: 2026, month: 7, openingBalance: 0, openedAt: new Date().toISOString() }
      )
    ]);

    const deposit = fakeEvent(
      WalletEvents.DEPOSIT_MADE,
      { wallet_id: walletId, deposit_id: "d1", year: "2026", month: "7", statement_id: statementId },
      { depositId: "d1", walletId, amount: 50, newBalance: 50, depositedAt: new Date().toISOString(), description: "x" }
    );

    await handle([deposit]);
    const rowAfterFirst = await statementRow(statementId);
    assert.strictEqual(Number(rowAfterFirst!.total_deposits), 50);
    assert.strictEqual(rowAfterFirst!.transaction_count, 1);

    // Redelivery of the exact same StoredEvent (same position) must not double-count.
    await handle([deposit]);
    const rowAfterRedelivery = await statementRow(statementId);
    assert.strictEqual(Number(rowAfterRedelivery!.total_deposits), 50);
    assert.strictEqual(rowAfterRedelivery!.transaction_count, 1);
  });

  it("WithdrawalMade increases total_withdrawals and transaction_count", async () => {
    const walletId = `wallet-${crypto.randomUUID()}`;
    const statementId = `wallet:${walletId}:2026-07`;
    await handle([
      fakeEvent(
        WalletEvents.WALLET_STATEMENT_OPENED,
        { wallet_id: walletId, statement_id: statementId, year: "2026", month: "7" },
        { walletId, statementId, year: 2026, month: 7, openingBalance: 100, openedAt: new Date().toISOString() }
      )
    ]);

    await handle([
      fakeEvent(
        WalletEvents.WITHDRAWAL_MADE,
        { wallet_id: walletId, withdrawal_id: "w1", year: "2026", month: "7", statement_id: statementId },
        { withdrawalId: "w1", walletId, amount: 30, newBalance: 70, withdrawnAt: new Date().toISOString(), description: "x" }
      )
    ]);

    const row = await statementRow(statementId);
    assert.strictEqual(Number(row!.total_withdrawals), 30);
    assert.strictEqual(row!.transaction_count, 1);
  });

  it("MoneyTransferred updates both wallets' statements independently (transfers_out / transfers_in)", async () => {
    const fromWalletId = `wallet-${crypto.randomUUID()}`;
    const toWalletId = `wallet-${crypto.randomUUID()}`;
    const fromStatementId = `wallet:${fromWalletId}:2026-07`;
    const toStatementId = `wallet:${toWalletId}:2026-07`;

    await handle([
      fakeEvent(
        WalletEvents.WALLET_STATEMENT_OPENED,
        { wallet_id: fromWalletId, statement_id: fromStatementId, year: "2026", month: "7" },
        { walletId: fromWalletId, statementId: fromStatementId, year: 2026, month: 7, openingBalance: 100, openedAt: new Date().toISOString() }
      ),
      fakeEvent(
        WalletEvents.WALLET_STATEMENT_OPENED,
        { wallet_id: toWalletId, statement_id: toStatementId, year: "2026", month: "7" },
        { walletId: toWalletId, statementId: toStatementId, year: 2026, month: 7, openingBalance: 0, openedAt: new Date().toISOString() }
      )
    ]);

    await handle([
      fakeEvent(
        WalletEvents.MONEY_TRANSFERRED,
        {
          transfer_id: "t1",
          from_wallet_id: fromWalletId,
          to_wallet_id: toWalletId,
          year: "2026",
          month: "7",
          from_statement_id: fromStatementId,
          to_statement_id: toStatementId
        },
        {
          transferId: "t1",
          fromWalletId,
          toWalletId,
          amount: 40,
          fromBalance: 60,
          toBalance: 40,
          transferredAt: new Date().toISOString(),
          description: "x"
        }
      )
    ]);

    const fromRow = await statementRow(fromStatementId);
    const toRow = await statementRow(toStatementId);
    assert.strictEqual(Number(fromRow!.total_transfers_out), 40);
    assert.strictEqual(fromRow!.transaction_count, 1);
    assert.strictEqual(Number(toRow!.total_transfers_in), 40);
    assert.strictEqual(toRow!.transaction_count, 1);
  });

  it("WalletStatementClosed sets closing_balance and closed_at exactly once", async () => {
    const walletId = `wallet-${crypto.randomUUID()}`;
    const statementId = `wallet:${walletId}:2026-06`;
    await handle([
      fakeEvent(
        WalletEvents.WALLET_STATEMENT_OPENED,
        { wallet_id: walletId, statement_id: statementId, year: "2026", month: "6" },
        { walletId, statementId, year: 2026, month: 6, openingBalance: 10, openedAt: new Date().toISOString() }
      )
    ]);

    const closed = fakeEvent(
      WalletEvents.WALLET_STATEMENT_CLOSED,
      { wallet_id: walletId, statement_id: statementId, year: "2026", month: "6" },
      { walletId, statementId, year: 2026, month: 6, openingBalance: 10, closingBalance: 55, closedAt: new Date().toISOString() }
    );
    await handle([closed]);
    const row = await statementRow(statementId);
    assert.strictEqual(Number(row!.closing_balance), 55);
    assert.ok(row!.closed_at !== null);

    // Redelivery must not error or double-apply (junction gate already recorded this position).
    await handle([closed]);
    const rowAfter = await statementRow(statementId);
    assert.strictEqual(Number(rowAfter!.closing_balance), 55);
  });

  it("a transaction event with no statement_id tag is a graceful no-op, not a crash", async () => {
    const walletId = `wallet-${crypto.randomUUID()}`;
    const deposit = fakeEvent(
      WalletEvents.DEPOSIT_MADE,
      { wallet_id: walletId, deposit_id: "orphan", year: "2026", month: "7" },
      { depositId: "orphan", walletId, amount: 10, newBalance: 10, depositedAt: new Date().toISOString(), description: "x" }
    );
    const handled = await handle([deposit]);
    assert.strictEqual(handled, 1, "the batch is still reported as processed - the projector itself doesn't fail");
  });

  it("multiple statements for the same wallet across different periods are tracked independently", async () => {
    const walletId = `wallet-${crypto.randomUUID()}`;
    const juneId = `wallet:${walletId}:2026-06`;
    const julyId = `wallet:${walletId}:2026-07`;

    await handle([
      fakeEvent(
        WalletEvents.WALLET_STATEMENT_OPENED,
        { wallet_id: walletId, statement_id: juneId, year: "2026", month: "6" },
        { walletId, statementId: juneId, year: 2026, month: 6, openingBalance: 0, openedAt: new Date().toISOString() }
      ),
      fakeEvent(
        WalletEvents.WALLET_STATEMENT_OPENED,
        { wallet_id: walletId, statement_id: julyId, year: "2026", month: "7" },
        { walletId, statementId: julyId, year: 2026, month: 7, openingBalance: 20, openedAt: new Date().toISOString() }
      )
    ]);

    await handle([
      fakeEvent(
        WalletEvents.DEPOSIT_MADE,
        { wallet_id: walletId, deposit_id: "june-dep", year: "2026", month: "6", statement_id: juneId },
        { depositId: "june-dep", walletId, amount: 5, newBalance: 5, depositedAt: new Date().toISOString(), description: "x" }
      ),
      fakeEvent(
        WalletEvents.DEPOSIT_MADE,
        { wallet_id: walletId, deposit_id: "july-dep", year: "2026", month: "7", statement_id: julyId },
        { depositId: "july-dep", walletId, amount: 15, newBalance: 35, depositedAt: new Date().toISOString(), description: "x" }
      )
    ]);

    const juneRow = await statementRow(juneId);
    const julyRow = await statementRow(julyId);
    assert.strictEqual(Number(juneRow!.total_deposits), 5);
    assert.strictEqual(Number(julyRow!.total_deposits), 15);
  });
});
