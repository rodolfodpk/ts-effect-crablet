// Runs under Node (Testcontainers) - see NOTES.md. Focused on the 5 command handlers' own
// decision-building logic in isolation, run through the real CommandExecutor against real
// Postgres (every handler but OpenWallet genuinely needs a real EventStore for period
// resolution/projections, so a true no-DB unit test isn't meaningful here) - not yet touching
// views, the automation, or HTTP composition.
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { Effect, Layer, Redacted } from "effect";
import { SqlClient } from "@effect/sql";
import { PgClient } from "@effect/sql-pg";
import { startTestDb, type TestDb } from "@crablet/test-support";
import { EventStore, EventStoreLive } from "@crablet/eventstore";
import { CommandAuditStore, CommandAuditStoreLive } from "@crablet/eventstore/CommandAuditStore";
import { ConcurrencyException } from "@crablet/eventstore/DCBViolation";
import { CommandExecutor, CommandExecutorLive } from "@crablet/commands";
import { openWalletCommandHandler, type OpenWalletCommand } from "../src/domain/commands/OpenWalletCommand.ts";
import { depositCommandHandler, type DepositCommand } from "../src/domain/commands/DepositCommand.ts";
import { withdrawCommandHandler, type WithdrawCommand } from "../src/domain/commands/WithdrawCommand.ts";
import { transferMoneyCommandHandler, type TransferMoneyCommand } from "../src/domain/commands/TransferMoneyCommand.ts";
import { closeWalletCommandHandler, type CloseWalletCommand } from "../src/domain/commands/CloseWalletCommand.ts";
import { WalletNotFound, InsufficientFunds } from "../src/domain/errors/WalletErrors.ts";

// Deliberately no applyAppMigrations() here (unlike statement-view.test.ts and the E2E suite) -
// these tests only touch EventStore/CommandExecutor, never the app-specific view tables
// (wallet_balance_view etc.), which don't exist until the view projectors are built (later in this
// phase's implementation order) - core crablet migrations from startTestDb() alone are enough.
let db: TestDb;
let layer: Layer.Layer<CommandExecutor | EventStore | CommandAuditStore | SqlClient.SqlClient, never>;

before(async () => {
  db = await startTestDb();
  const pgLayer = PgClient.layer({
    host: db.connInfo.host,
    port: db.connInfo.port,
    database: db.connInfo.database,
    username: db.connInfo.username,
    password: Redacted.make(db.connInfo.password)
  });
  const appLayers = Layer.mergeAll(CommandExecutorLive, EventStoreLive, CommandAuditStoreLive);
  layer = Layer.provideMerge(appLayers, pgLayer) as unknown as Layer.Layer<
    CommandExecutor | EventStore | CommandAuditStore | SqlClient.SqlClient,
    never
  >;
}, { timeout: 60_000 });

after(async () => {
  await db.stop();
});

const run = <A, E>(
  effect: Effect.Effect<A, E, CommandExecutor | EventStore | CommandAuditStore | SqlClient.SqlClient>
) => Effect.runPromise(Effect.provide(effect, layer) as Effect.Effect<A, E, never>);

const openWallet = (walletId: string, owner = "Alice", initialBalance = 0) =>
  run(
    Effect.gen(function* () {
      const executor = yield* CommandExecutor;
      const command: OpenWalletCommand = { walletId, owner, initialBalance };
      return yield* executor.execute("open_wallet", command, openWalletCommandHandler);
    })
  );

describe("wallet domain command handlers (real Postgres)", () => {
  it("OpenWalletCommand: creates a wallet, THROWs (ConcurrencyException) on a duplicate open", async () => {
    const walletId = `wallet-${crypto.randomUUID()}`;
    const first = await openWallet(walletId, "Alice", 100);
    assert.strictEqual(first.wasIdempotent, false);

    const outcome = await run(
      Effect.gen(function* () {
        const executor = yield* CommandExecutor;
        const command: OpenWalletCommand = { walletId, owner: "Alice", initialBalance: 100 };
        return yield* executor.execute("open_wallet", command, openWalletCommandHandler).pipe(
          Effect.map(() => "success" as const),
          Effect.catchTag("ConcurrencyException", (e) => Effect.succeed(e))
        );
      })
    );
    assert.ok(outcome instanceof ConcurrencyException, `expected ConcurrencyException, got ${JSON.stringify(outcome)}`);
  });

  it("DepositCommand: increases the balance; fails WalletNotFound for a nonexistent wallet", async () => {
    const walletId = `wallet-${crypto.randomUUID()}`;
    await openWallet(walletId, "Bob", 50);

    const result = await run(
      Effect.gen(function* () {
        const executor = yield* CommandExecutor;
        const command: DepositCommand = {
          depositId: crypto.randomUUID(),
          walletId,
          amount: 25,
          description: "test deposit"
        };
        return yield* executor.execute("deposit", command, depositCommandHandler);
      })
    );
    assert.strictEqual(result.wasIdempotent, false);

    const ghostWalletId = `wallet-${crypto.randomUUID()}`;
    const outcome = await run(
      Effect.gen(function* () {
        const executor = yield* CommandExecutor;
        const command: DepositCommand = {
          depositId: crypto.randomUUID(),
          walletId: ghostWalletId,
          amount: 10,
          description: "ghost"
        };
        return yield* executor.execute("deposit", command, depositCommandHandler).pipe(
          Effect.map(() => "success" as const),
          Effect.catchTag("WalletNotFound", (e) => Effect.succeed(e))
        );
      })
    );
    assert.ok(outcome instanceof WalletNotFound);
  });

  it("WithdrawCommand: fails InsufficientFunds when amount exceeds balance; duplicate withdrawal_id is a NoOp", async () => {
    const walletId = `wallet-${crypto.randomUUID()}`;
    await openWallet(walletId, "Carol", 30);

    const insufficientOutcome = await run(
      Effect.gen(function* () {
        const executor = yield* CommandExecutor;
        const command: WithdrawCommand = {
          withdrawalId: crypto.randomUUID(),
          walletId,
          amount: 100,
          description: "too much"
        };
        return yield* executor.execute("withdraw", command, withdrawCommandHandler).pipe(
          Effect.map(() => "success" as const),
          Effect.catchTag("InsufficientFunds", (e) => Effect.succeed(e))
        );
      })
    );
    assert.ok(insufficientOutcome instanceof InsufficientFunds);
    if (insufficientOutcome instanceof InsufficientFunds) {
      assert.strictEqual(insufficientOutcome.currentBalance, 30);
      assert.strictEqual(insufficientOutcome.requestedAmount, 100);
    }

    const withdrawalId = crypto.randomUUID();
    const first = await run(
      Effect.gen(function* () {
        const executor = yield* CommandExecutor;
        const command: WithdrawCommand = { withdrawalId, walletId, amount: 10, description: "ok" };
        return yield* executor.execute("withdraw", command, withdrawCommandHandler);
      })
    );
    assert.strictEqual(first.wasIdempotent, false);

    const retry = await run(
      Effect.gen(function* () {
        const executor = yield* CommandExecutor;
        const command: WithdrawCommand = { withdrawalId, walletId, amount: 10, description: "ok" };
        return yield* executor.execute("withdraw", command, withdrawCommandHandler);
      })
    );
    assert.strictEqual(retry.wasIdempotent, true, "duplicate withdrawal_id should short-circuit to NoOp/idempotent");
  });

  it("TransferMoneyCommand: moves funds between two wallets; fails InsufficientFunds on the source", async () => {
    const fromWalletId = `wallet-${crypto.randomUUID()}`;
    const toWalletId = `wallet-${crypto.randomUUID()}`;
    await openWallet(fromWalletId, "Dave", 100);
    await openWallet(toWalletId, "Erin", 0);

    const result = await run(
      Effect.gen(function* () {
        const executor = yield* CommandExecutor;
        const command: TransferMoneyCommand = {
          transferId: crypto.randomUUID(),
          fromWalletId,
          toWalletId,
          amount: 40,
          description: "test transfer"
        };
        return yield* executor.execute("transfer_money", command, transferMoneyCommandHandler);
      })
    );
    assert.strictEqual(result.wasIdempotent, false);

    const outcome = await run(
      Effect.gen(function* () {
        const executor = yield* CommandExecutor;
        const command: TransferMoneyCommand = {
          transferId: crypto.randomUUID(),
          fromWalletId,
          toWalletId,
          amount: 1000,
          description: "too much"
        };
        return yield* executor.execute("transfer_money", command, transferMoneyCommandHandler).pipe(
          Effect.map(() => "success" as const),
          Effect.catchTag("InsufficientFunds", (e) => Effect.succeed(e))
        );
      })
    );
    assert.ok(outcome instanceof InsufficientFunds);
  });

  it("CloseWalletCommand: closes an open wallet; fails WalletNotFound for a nonexistent wallet", async () => {
    const walletId = `wallet-${crypto.randomUUID()}`;
    await openWallet(walletId, "Frank", 0);

    const result = await run(
      Effect.gen(function* () {
        const executor = yield* CommandExecutor;
        const command: CloseWalletCommand = { walletId };
        return yield* executor.execute("close_wallet", command, closeWalletCommandHandler);
      })
    );
    assert.strictEqual(result.wasIdempotent, false);

    const ghostWalletId = `wallet-${crypto.randomUUID()}`;
    const outcome = await run(
      Effect.gen(function* () {
        const executor = yield* CommandExecutor;
        const command: CloseWalletCommand = { walletId: ghostWalletId };
        return yield* executor.execute("close_wallet", command, closeWalletCommandHandler).pipe(
          Effect.map(() => "success" as const),
          Effect.catchTag("WalletNotFound", (e) => Effect.succeed(e))
        );
      })
    );
    assert.ok(outcome instanceof WalletNotFound);
  });
});
