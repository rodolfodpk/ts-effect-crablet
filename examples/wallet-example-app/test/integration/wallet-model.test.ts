// Runs under Node (Testcontainers). The declarative wallet model against real Postgres: its state
// after real commands, and its boundary query + log position as a real append condition.
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { Effect, Layer, Redacted } from "effect";
import { SqlClient } from "effect/sql";
import { PgClient } from "@effect/sql-pg";
import { startTestDb, type TestDb } from "@crablet/test-support";
import { EventStore, EventStoreLive } from "@crablet/eventstore";
import { CommandAuditStore, CommandAuditStoreLive } from "@crablet/eventstore/CommandAuditStore";
import * as AppendCondition from "@crablet/eventstore/AppendCondition";
import * as AppendEvent from "@crablet/eventstore/AppendEvent";
import { Conflict } from "@crablet/eventstore/AppendErrors";
import { CommandExecutor, CommandExecutorLive, type CommandHandler } from "@crablet/commands";
import { all } from "@crablet/commands/Model";
import { openWalletCommandHandler } from "../../src/domain/commands/OpenWalletCommand.ts";
import { depositCommandHandler } from "../../src/domain/commands/DepositCommand.ts";
import { withdrawCommandHandler } from "../../src/domain/commands/WithdrawCommand.ts";
import { transferMoneyCommandHandler } from "../../src/domain/commands/TransferMoneyCommand.ts";
import { WalletModel } from "../../src/domain/WalletModel.ts";

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

const run = <A, E>(effect: Effect.Effect<A, E, CommandExecutor | EventStore | CommandAuditStore | SqlClient.SqlClient>) =>
  Effect.runPromise(Effect.provide(effect, layer) as Effect.Effect<A, E, never>);

// The current statement period, computed the same way the commands' period resolver does (UTC).
const now = new Date();
const period = { year: now.getUTCFullYear(), month: now.getUTCMonth() + 1 };
const id = (p: string) => `${p}-${crypto.randomUUID()}`;

const exec = <T, E>(type: string, command: T, handler: CommandHandler<T, E>) =>
  run(Effect.flatMap(CommandExecutor, (e) => e.execute(type, command, handler)));

const loadWallet = (walletId: string) =>
  run(Effect.flatMap(EventStore, (es) => WalletModel.of({ id: walletId, ...period }).load(es)));

describe("wallet model against real Postgres", () => {
  it("state after real commands: deposits, withdrawals and a transfer, for sender AND receiver", async () => {
    const a = id("a");
    const b = id("b");
    await exec("open_wallet", { walletId: a, owner: "Ann", initialBalance: 100 }, openWalletCommandHandler);
    await exec("open_wallet", { walletId: b, owner: "Bob", initialBalance: 0 }, openWalletCommandHandler);
    await exec("deposit", { depositId: id("d"), walletId: a, amount: 25, description: "" }, depositCommandHandler);
    await exec("withdraw", { withdrawalId: id("x"), walletId: a, amount: 10, description: "" }, withdrawCommandHandler);
    await exec(
      "transfer_money",
      { transferId: id("t"), fromWalletId: a, toWalletId: b, amount: 40, description: "" },
      transferMoneyCommandHandler
    );

    assert.deepEqual((await loadWallet(a)).state, { exists: true, balance: 75 }); // 100 + 25 - 10 - 40
    assert.deepEqual((await loadWallet(b)).state, { exists: true, balance: 40 }); // receiver: the fixed attribution
    assert.deepEqual((await loadWallet(id("ghost"))).state, { exists: false, balance: 0 });
  });

  it("the boundary query + log position work as a real append condition (multi-item, via the SQL path)", async () => {
    const w = id("w");
    await exec("open_wallet", { walletId: w, owner: "Ann", initialBalance: 10 }, openWalletCommandHandler);

    const model = WalletModel.of({ id: w, ...period });
    const { logPosition } = await run(Effect.flatMap(EventStore, (es) => model.load(es)));
    const probe = () => [AppendEvent.ofUntagged("ModelProbe", { n: 1 })];
    const condition = AppendCondition.of(logPosition, model.query);

    // Nothing in the boundary changed since the load: the append is accepted.
    await run(Effect.flatMap(EventStore, (es) => es.append(probe(), condition)));

    // A deposit lands in the boundary (a scoped, period-tagged event - matched by one item of the query).
    await exec("deposit", { depositId: id("d"), walletId: w, amount: 5, description: "" }, depositCommandHandler);

    // The same stale decision is now refused, as a boundary Conflict.
    const refused = await run(
      Effect.flatMap(EventStore, (es) =>
        es.append(probe(), condition).pipe(
          Effect.map(() => "appended" as const),
          Effect.catchTag("Conflict", (c) => Effect.succeed(c))
        )
      )
    );
    assert.ok(refused instanceof Conflict, `expected Conflict, got ${JSON.stringify(refused)}`);
    assert.equal(refused.kind, "boundary");
  });

  it("a two-wallet model reads both wallets and guards both: a change to EITHER refuses a stale decision", async () => {
    const a = id("a");
    const b = id("b");
    await exec("open_wallet", { walletId: a, owner: "Ann", initialBalance: 50 }, openWalletCommandHandler);
    await exec("open_wallet", { walletId: b, owner: "Bob", initialBalance: 50 }, openWalletCommandHandler);

    const both = all({ from: WalletModel.of({ id: a, ...period }), to: WalletModel.of({ id: b, ...period }) });
    const { state, logPosition } = await run(Effect.flatMap(EventStore, (es) => both.load(es)));
    assert.equal(state.from.balance, 50);
    assert.equal(state.to.balance, 50);

    // Only the RECEIVER changes.
    await exec("deposit", { depositId: id("d"), walletId: b, amount: 1, description: "" }, depositCommandHandler);

    const outcome = await run(
      Effect.flatMap(EventStore, (es) =>
        es.append([AppendEvent.ofUntagged("ModelProbe", {})], AppendCondition.of(logPosition, both.query)).pipe(
          Effect.map(() => "appended" as const),
          Effect.catchTag("Conflict", () => Effect.succeed("conflict" as const))
        )
      )
    );
    assert.equal(outcome, "conflict");
  });
});
