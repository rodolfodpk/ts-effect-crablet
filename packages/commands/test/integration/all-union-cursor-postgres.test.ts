// Runs under Node (Testcontainers). The interleaving that makes the WRONG cursor for a model over several entities (`all`) lose a conflict, forced through the real
// executor (ADR-0018, decision 8; the SQL-level proof is eventstore's union-boundary-cursor.test.ts):
//   1. a transaction T2 (lower xid) has inserted an event into member X's boundary and is still open;
//   2. the command loads X: its read cannot see T2's event, so X's state is stale (X still has its 100);
//   3. T2 commits, and a newer event (higher xid) is committed into member Y's boundary;
//   4. the command loads Y: it sees its newer event, settled.
// A cursor taken from the members' newest events (the maximum) would sit above T2's event, and the append would be accepted over a state that lacks it:
// X would be overspent. The cursor from the members' read horizons sits below it: the append is refused, the command reloads, sees X's real balance, and the
// domain refuses the transfer.
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { Client } from "pg";
import { Effect, Redacted } from "effect";
import { startTestDb, type TestDb } from "@crablet/test-support";
import { EventStore } from "@crablet/eventstore";
import * as Crablet from "../../src/Crablet.ts";
import { CommandExecutor } from "../../src/CommandExecutor.ts";
import { defineCommand, emit, fail } from "../../src/Command.ts";
import { all } from "../../src/Model.ts";
import { afterLoad } from "../support/barrier.ts";
import { AccountModel, AccountNotFound, AccountOpened, InsufficientFunds, Transferred, transferInput } from "../support/transfer.ts";

let db: TestDb;
before(async () => { db = await startTestDb(); }, { timeout: 60_000 });
after(async () => { await db.stop(); });

const AppLive = () =>
  Crablet.layer({ host: db.connInfo.host, port: db.connInfo.port, database: db.connInfo.database, username: db.connInfo.username, password: Redacted.make(db.connInfo.password) });
const run = <A, E>(e: Effect.Effect<A, E, any>) => Effect.runPromise(Effect.provide(e, AppLive()) as Effect.Effect<A, E, never>);
const connect = async () => {
  const c = new Client({ host: db.connInfo.host, port: db.connInfo.port, database: db.connInfo.database, user: db.connInfo.username, password: db.connInfo.password });
  await c.connect();
  return c;
};
const uid = () => crypto.randomUUID().slice(0, 8);
const errorOf = (exit: any) => exit.cause?.reasons?.find((r: any) => r._tag === "Fail")?.error;

describe("a transfer whose two accounts are read at different moments", () => {
  it("does not accept a decision made on an account read just before a lower-xid transaction committed", { timeout: 60_000 }, async () => {
    const [x, y, w] = [`x-${uid()}`, `y-${uid()}`, `w-${uid()}`];
    await run(Effect.flatMap(EventStore, (es) => es.append([AccountOpened({ accountId: x, balance: 100 }), AccountOpened({ accountId: y, balance: 0 }), AccountOpened({ accountId: w, balance: 0 })])));

    const t2 = await connect(); // the lower-xid transaction
    const other = await connect();
    try {
      await t2.query("BEGIN");
      // T2 spends 80 of X to W, and has not committed
      await t2.query(
        "INSERT INTO crablet_events (type, tags, data, transaction_id) VALUES ('Transferred', ARRAY[$1, $2, $3]::text[], $4::jsonb, pg_current_xact_id())",
        [`transfer_id=${uid()}`, `from_account_id=${x}`, `to_account_id=${w}`, JSON.stringify({ transferId: "t2", from: x, to: w, amount: 80 })]
      );

      let first = true;
      const between = Effect.promise(async () => {
        if (!first) return;
        first = false;
        await t2.query("COMMIT"); // T2's event becomes visible, after X was read
        // a newer event in Y's boundary, a higher xid, committed
        await other.query("INSERT INTO crablet_events (type, tags, data, transaction_id) VALUES ('Deposited', ARRAY[$1]::text[], $2::jsonb, pg_current_xact_id())", [`account_id=${y}`, JSON.stringify({ accountId: y, amount: 1 })]);
      });

      const Racing = defineCommand({
        name: "transfer_straddled",
        errors: [AccountNotFound, InsufficientFunds],
        input: transferInput,
        // X is read FIRST, then `between` runs, then Y is read
        model: (c) => all({ from: afterLoad(AccountModel.of({ id: c.from }), between), to: AccountModel.of({ id: c.to }) }),
        retries: 3,
        decide: ({ from, to }, c) =>
          !from.exists || !to.exists
            ? fail(new AccountNotFound({ accountId: c.from }))
            : from.balance < c.amount
              ? fail(new InsufficientFunds({ accountId: c.from, balance: from.balance, requested: c.amount }))
              : emit(Transferred(c))
      });

      const outcome = await run(
        Effect.gen(function* () {
          const exit = yield* Effect.exit((yield* CommandExecutor).run(Racing, { transferId: uid(), from: x, to: y, amount: 80 }));
          const balance = yield* Effect.flatMap(EventStore, (es) => Effect.map(AccountModel.of({ id: x }).load(es), (l) => l.state.balance));
          return { exit, balance };
        })
      );

      assert.ok(outcome.balance >= 0, `X was overspent (balance ${outcome.balance}): the append was accepted over a state that lacked T2's event`);
      assert.strictEqual(outcome.balance, 20, "only T2's 80 left X");
      assert.ok(errorOf(outcome.exit) instanceof InsufficientFunds, "the command reloaded, saw 20, and the domain refused the 80");
    } finally {
      await Promise.all([t2.end(), other.end()]);
    }
  });
});
