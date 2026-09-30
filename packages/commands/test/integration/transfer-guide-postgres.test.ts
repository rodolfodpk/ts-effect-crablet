// Runs under Node (Testcontainers). The DCB guide's transfer example against real Postgres: races are
// made deterministic with a barrier in `prepare`, so every racer has LOADED before any appends.
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { Deferred, Effect, Redacted, Ref } from "effect";
import { startTestDb, type TestDb } from "@crablet/test-support";
import { EventStore } from "@crablet/eventstore";
import { Conflict } from "@crablet/eventstore/AppendErrors";
import * as Crablet from "../../src/Crablet.ts";
import { CommandExecutor } from "../../src/CommandExecutor.ts";
import { AccountModel, AccountOpened, InsufficientFunds, Transfer, transferWith } from "../support/transfer.ts";

let db: TestDb;
before(async () => {
  db = await startTestDb();
}, { timeout: 60_000 });
after(async () => {
  await db.stop();
});

const AppLive = () =>
  Crablet.layer({
    host: db.connInfo.host,
    port: db.connInfo.port,
    database: db.connInfo.database,
    username: db.connInfo.username,
    password: Redacted.make(db.connInfo.password)
  });
const run = <A, E>(e: Effect.Effect<A, E, any>) => Effect.runPromise(Effect.provide(e, AppLive()) as Effect.Effect<A, E, never>);

const barrier = (parties: number) =>
  Effect.gen(function* () {
    const arrived = yield* Ref.make(0);
    const gate = yield* Deferred.make<void>();
    return Effect.gen(function* () {
      if ((yield* Ref.updateAndGet(arrived, (n) => n + 1)) >= parties) yield* Deferred.succeed(gate, undefined);
      yield* Deferred.await(gate);
    });
  });

const uid = () => crypto.randomUUID().slice(0, 8);
const open = (id: string, balance: number) =>
  Effect.flatMap(EventStore, (es) => es.append([AccountOpened({ accountId: id, balance })]));
const balanceOf = (id: string) =>
  Effect.flatMap(EventStore, (es) => Effect.map(AccountModel.of({ id }).load(es), (l) => l.state.balance));
const errorOf = (exit: any) => exit.cause?.reasons?.find((r: any) => r._tag === "Fail")?.error;
const exitAll = (effects: ReadonlyArray<Effect.Effect<any, any, any>>) =>
  Effect.all(effects.map((e) => Effect.exit(e)), { concurrency: effects.length });

describe("transfer against Postgres", () => {
  it("a plain transfer moves money between two accounts, atomically", async () => {
    const [a, b] = [`a-${uid()}`, `b-${uid()}`];
    const balances = await run(
      Effect.gen(function* () {
        yield* open(a, 100);
        yield* open(b, 5);
        yield* (yield* CommandExecutor).run(Transfer, { transferId: uid(), from: a, to: b, amount: 40 });
        return [yield* balanceOf(a), yield* balanceOf(b)];
      })
    );
    assert.deepEqual(balances, [60, 45]);
  });

  it("two transfers that would OVERSPEND the same account: exactly one wins; the loser re-decides and is refused", async () => {
    const [a, b, c] = [`a-${uid()}`, `b-${uid()}`, `c-${uid()}`];
    const result = await run(
      Effect.gen(function* () {
        yield* open(a, 100);
        yield* open(b, 0);
        yield* open(c, 0);
        const wait = yield* barrier(2);
        const cmd = transferWith({ wait });
        const executor = yield* CommandExecutor;
        // both load a=100 and both decide "80 is fine" - only one append may succeed
        const exits = yield* exitAll([
          executor.run(cmd, { transferId: uid(), from: a, to: b, amount: 80 }),
          executor.run(cmd, { transferId: uid(), from: a, to: c, amount: 80 })
        ]);
        return { exits, balances: [yield* balanceOf(a), yield* balanceOf(b), yield* balanceOf(c)] };
      })
    );
    assert.equal(result.exits.filter((e) => e._tag === "Success").length, 1);
    assert.ok(errorOf(result.exits.find((e) => e._tag === "Failure")) instanceof InsufficientFunds);
    assert.equal(result.balances[0], 20, "a was debited once, not twice");
    assert.equal(result.balances[1]! + result.balances[2]!, 80);
  });

  it("transfers between DISJOINT accounts never conflict, even fully concurrent with retries off", async () => {
    const ids = [1, 2, 3, 4].map((n) => `${n}-${uid()}`);
    const exits = await run(
      Effect.gen(function* () {
        for (const id of ids) yield* open(id, 100);
        const wait = yield* barrier(2);
        const cmd = transferWith({ wait, retries: 0 });
        const executor = yield* CommandExecutor;
        return yield* exitAll([
          executor.run(cmd, { transferId: uid(), from: ids[0]!, to: ids[1]!, amount: 10 }),
          executor.run(cmd, { transferId: uid(), from: ids[2]!, to: ids[3]!, amount: 10 })
        ]);
      })
    );
    assert.deepEqual(exits.map((e) => e._tag), ["Success", "Success"]);
  });

  it("transfers that share only the RECEIVER do share a boundary: with retries off one gets a Conflict; with retries both succeed", async () => {
    const setup = Effect.gen(function* () {
      const [a, c, b] = [`a-${uid()}`, `c-${uid()}`, `b-${uid()}`];
      yield* open(a, 100);
      yield* open(c, 100);
      yield* open(b, 0);
      return { a, c, b };
    });
    const race = (retries: number) =>
      run(
        Effect.gen(function* () {
          const { a, c, b } = yield* setup;
          const wait = yield* barrier(2);
          const cmd = transferWith({ wait, retries });
          const executor = yield* CommandExecutor;
          const exits = yield* exitAll([
            executor.run(cmd, { transferId: uid(), from: a, to: b, amount: 10 }),
            executor.run(cmd, { transferId: uid(), from: c, to: b, amount: 10 })
          ]);
          return { exits, received: yield* balanceOf(b) };
        })
      );

    const strict = await race(0);
    assert.equal(strict.exits.filter((e) => e._tag === "Success").length, 1);
    const error = errorOf(strict.exits.find((e) => e._tag === "Failure"));
    assert.ok(error instanceof Conflict);
    assert.equal(strict.received, 10);

    const retried = await race(3);
    assert.deepEqual(retried.exits.map((e) => e._tag), ["Success", "Success"]);
    assert.equal(retried.received, 20, "both transfers landed; neither was lost");
  });

  it("a repeated transfer id is 'already done' on Postgres too", async () => {
    const [a, b] = [`a-${uid()}`, `b-${uid()}`];
    const transferId = uid();
    const out = await run(
      Effect.gen(function* () {
        yield* open(a, 50);
        yield* open(b, 0);
        const executor = yield* CommandExecutor;
        const first = yield* executor.run(Transfer, { transferId, from: a, to: b, amount: 50 });
        const again = yield* executor.run(Transfer, { transferId, from: a, to: b, amount: 50 });
        return { first, again, a: yield* balanceOf(a), b: yield* balanceOf(b) };
      })
    );
    assert.equal(out.first.wasIdempotent, false);
    assert.equal(out.again.wasIdempotent, true);
    assert.deepEqual([out.a, out.b], [0, 50]);
  });
});
