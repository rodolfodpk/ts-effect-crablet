// Runs under Node (Testcontainers). A transaction open somewhere else in the database, with nothing to do with a command, does not make the command
// fail (ADR-0048). While it is open, the oldest running xid (xmin) stays below everything written after it, so those events are not "settled"; the
// append counted every loaded-but-unsettled event as a conflict, and the immediate retries met the same xmin until the command gave up with Conflict.
// The condition now carries the snapshot the read was taken in, and only what that snapshot could not see is a conflict.
// Each path a command's cursor comes from: one model (its last settled event), `all(...)` (the earliest horizon), and `resolve` (a lookup joined in).
// And the other side: an event of a transaction that was running when the read was taken, committed before the append, is still a conflict (the
// snapshot lists it as running). Committed by a transaction that started after the read: dcb-examples-postgres.test.ts and all-union-cursor-postgres.test.ts.
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { Client } from "pg";
import { Effect, Metric, Redacted } from "effect";
import { startTestDb, type TestDb } from "@crablet/test-support";
import { EventStore } from "@crablet/eventstore";
import * as CommandMetrics from "@crablet/metrics-otel/CommandMetrics";
import * as Crablet from "../../src/Crablet.ts";
import { CommandExecutor } from "../../src/CommandExecutor.ts";
import { defineCommand, emit, fail, type Command } from "../../src/Command.ts";
import { afterLoad } from "../support/barrier.ts";
import { AccountModel, AccountNotFound, AccountOpened, InsufficientFunds, Transfer, Transferred, transferInput } from "../support/transfer.ts";
import { CopyAddedToCatalog, CopyLent, MemberSuspended, ReinstateMember, RenewLoan } from "../support/dcb-examples.ts";

let db: TestDb;
before(async () => { db = await startTestDb(); }, { timeout: 60_000 });
after(async () => { await db.stop(); });

const AppLive = () =>
  Crablet.layer({ host: db.connInfo.host, port: db.connInfo.port, database: db.connInfo.database, username: db.connInfo.username, password: Redacted.make(db.connInfo.password) });
const run = <A, E>(e: Effect.Effect<A, E, any>) => Effect.runPromise(Effect.provide(e, AppLive()) as Effect.Effect<A, E, never>);
const uid = () => crypto.randomUUID().slice(0, 8);
const retriesOf = (commandType: string) =>
  Effect.map(Metric.value(Metric.withAttributes(CommandMetrics.conflictRetries, { command_type: commandType })), (m) => m.count);

// A transaction that has an xid (so it holds xmin back) and stays open while `body` runs: what a slow batch or an idle-in-transaction session does.
const withOpenTransaction = async <A>(body: () => Promise<A>): Promise<A> => {
  const other = new Client({ host: db.connInfo.host, port: db.connInfo.port, database: db.connInfo.database, user: db.connInfo.username, password: db.connInfo.password });
  await other.connect();
  try {
    await other.query("BEGIN");
    await other.query("SELECT pg_current_xact_id()");
    return await body();
  } finally {
    await other.query("ROLLBACK");
    await other.end();
  }
};

// Writes `setup` (after the open transaction began, so its events are not settled), then runs the command: it succeeds at the first attempt.
const succeedsFirstTime = <In>(setup: ReadonlyArray<Parameters<EventStore["Service"]["append"]>[0][number]>, command: Command<In, any>, input: In) =>
  withOpenTransaction(() =>
    run(
      Effect.gen(function* () {
        yield* (yield* EventStore).append(setup);
        const before = yield* retriesOf(command.name);
        const exit = yield* Effect.exit((yield* CommandExecutor).run(command, input));
        return { exit, retries: (yield* retriesOf(command.name)) - before };
      })
    )
  ).then(({ exit, retries }) => {
    assert.strictEqual(exit._tag, "Success", `${command.name} failed while an unrelated transaction was open: ${JSON.stringify(exit, (_k, v) => (typeof v === "bigint" ? v.toString() : v))}`);
    assert.strictEqual(retries, 0, `${command.name} was retried ${retries} time(s): an event it had read counted as a conflict`);
  });

describe("an unrelated open transaction", () => {
  it("one model: a command over events written after the transaction began is not a conflict", async () => {
    const member = `m-${uid()}`;
    await succeedsFirstTime([MemberSuspended({ memberId: member })], ReinstateMember, { memberId: member });
  });

  it("all(...): a transfer between accounts opened after the transaction began is not a conflict", async () => {
    const [from, to] = [`a-${uid()}`, `a-${uid()}`];
    await succeedsFirstTime(
      [AccountOpened({ accountId: from, balance: 100 }), AccountOpened({ accountId: to, balance: 0 })],
      Transfer,
      { transferId: `t-${uid()}`, from, to, amount: 10 }
    );
  });

  it("resolve: a renewal whose lookup reads events written after the transaction began is not a conflict", async () => {
    const [copy, member] = [`c-${uid()}`, `m-${uid()}`];
    await succeedsFirstTime([CopyAddedToCatalog({ copyId: copy, bookId: `b-${uid()}` }), CopyLent({ copyId: copy, memberId: member })], RenewLoan, { copyId: copy });
  });
});

describe("a transaction running when the command read", () => {
  it("its event in the boundary, committed after the read and before the append, is a conflict: the command re-decides on it", { timeout: 60_000 }, async () => {
    const [x, w] = [`x-${uid()}`, `w-${uid()}`];
    await run(Effect.flatMap(EventStore, (es) => es.append([AccountOpened({ accountId: x, balance: 100 }), AccountOpened({ accountId: w, balance: 0 })])));
    const t2 = new Client({ host: db.connInfo.host, port: db.connInfo.port, database: db.connInfo.database, user: db.connInfo.username, password: db.connInfo.password });
    await t2.connect();
    try {
      await t2.query("BEGIN");
      // T2 spends 80 of X and has not committed: it is running when the command reads X
      await t2.query(
        "INSERT INTO crablet_events (type, tags, data, transaction_id) VALUES ('Transferred', ARRAY[$1, $2, $3]::text[], $4::jsonb, pg_current_xact_id())",
        [`transfer_id=${uid()}`, `from_account_id=${x}`, `to_account_id=${w}`, JSON.stringify({ transferId: "t2", from: x, to: w, amount: 80 })]
      );
      // A newer transaction finishes before the read, so the read's snapshot has its xmax above T2 and lists T2 as running (in xip), not as
      // "not started yet": the case where only the running list makes T2's event a conflict.
      await run(Effect.flatMap(EventStore, (es) => es.append([AccountOpened({ accountId: `z-${uid()}`, balance: 0 })])));
      let first = true;
      const commitT2 = Effect.promise(async () => {
        if (!first) return;
        first = false;
        await t2.query("COMMIT"); // after the read, before the append
      });
      // One model only, so nothing but T2's event can make the append conflict.
      const Spend = defineCommand({
        name: "spend_after_running_read",
        errors: [AccountNotFound, InsufficientFunds],
        input: transferInput,
        model: (c) => afterLoad(AccountModel.of({ id: c.from }), commitT2),
        decide: (from, c) =>
          !from.exists
            ? fail(new AccountNotFound({ accountId: c.from }))
            : from.balance < c.amount
              ? fail(new InsufficientFunds({ accountId: c.from, balance: from.balance, requested: c.amount }))
              : emit(Transferred(c))
      });
      const outcome = await run(
        Effect.gen(function* () {
          const exit = yield* Effect.exit((yield* CommandExecutor).run(Spend, { transferId: uid(), from: x, to: w, amount: 80 }));
          const balance = yield* Effect.flatMap(EventStore, (es) => Effect.map(AccountModel.of({ id: x }).load(es), (l) => l.state.balance));
          return { exit, balance };
        })
      );
      assert.strictEqual(outcome.balance, 20, `X was overspent (balance ${outcome.balance}): the append was accepted over a read that did not see T2's event`);
      assert.ok((outcome.exit as any).cause?.reasons?.find((r: any) => r._tag === "Fail")?.error instanceof InsufficientFunds, "the command re-read X, saw 20, and refused the 80");
    } finally {
      await t2.end();
    }
  });
});
