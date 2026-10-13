// Runs under Node (Testcontainers). What `resolve` reads joins the command's condition (Command.ts, `resolve`): a lookup that changes between
// the lookup and the append refuses the append, and the command runs again with a fresh lookup. The race is forced, not hoped for: the
// command waits after its lookup until the card has been cancelled, and only then decides and appends.
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { Deferred, Effect, Redacted } from "effect";
import * as Schema from "effect/Schema";
import { startTestDb, type TestDb } from "@crablet/test-support";
import { EventStore } from "@crablet/eventstore";
import * as Crablet from "../../src/Crablet.ts";
import { CommandExecutor } from "../../src/CommandExecutor.ts";
import { defineCommand, emit, fail, type ResolveReader } from "../../src/Command.ts";
import { BookLent, CardCancelled, CardIssued, CardModel, CardNotValid, MemberModel } from "../support/borrow-book.ts";

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

// The guide's library (support/borrow-book.ts): a card names a member, and a loan is the member's. The command here is the guide's `BorrowBook` with a wait after the lookup, so the
// test can cancel the card between the lookup and the append.
const input = Schema.Struct({ cardNumber: Schema.String, bookId: Schema.String });

// The command looks the card up, then waits (only on its first attempt) until the test has cancelled the card.
const lookUp = (lookedUp: Deferred.Deferred<void>, cancelled: Deferred.Deferred<void>) => (c: { readonly cardNumber: string }, read: ResolveReader) =>
  Effect.gen(function* () {
    const card = yield* read.load(CardModel.of({ id: c.cardNumber }));
    if (yield* Deferred.succeed(lookedUp, undefined)) yield* Deferred.await(cancelled);
    return card.memberId;
  });
const lend = (c: { readonly cardNumber: string; readonly bookId: string }, memberId: string | null) =>
  memberId === null ? fail(new CardNotValid({ cardNumber: c.cardNumber })) : emit(BookLent({ memberId, bookId: c.bookId }));

const borrowBook = (lookedUp: Deferred.Deferred<void>, cancelled: Deferred.Deferred<void>, withModel: boolean) =>
  withModel
    ? defineCommand({
        name: "rl_borrow",
        input,
        errors: [CardNotValid],
        resolve: lookUp(lookedUp, cancelled),
        model: (_, { resolved }) => MemberModel.of({ id: resolved ?? "nobody" }),
        decide: (_, c, { resolved }) => lend(c, resolved)
      })
    : defineCommand({
        name: "rl_borrow",
        input,
        errors: [CardNotValid],
        resolve: lookUp(lookedUp, cancelled),
        decide: (_, c, { resolved }) => lend(c, resolved)
      });

const race = (withModel: boolean) =>
  run(
    Effect.gen(function* () {
      const cardNumber = `card-${crypto.randomUUID().slice(0, 8)}`;
      const es = yield* EventStore;
      yield* es.append([CardIssued({ cardNumber, memberId: `m-${cardNumber}` })]);
      const lookedUp = yield* Deferred.make<void>();
      const cancelled = yield* Deferred.make<void>();
      const executor = yield* CommandExecutor;
      const cancel = Effect.gen(function* () {
        yield* Deferred.await(lookedUp);
        yield* es.append([CardCancelled({ cardNumber })]);
        yield* Deferred.succeed(cancelled, undefined);
      });
      const [borrow] = yield* Effect.all([Effect.exit(executor.run(borrowBook(lookedUp, cancelled, withModel), { cardNumber, bookId: "b1" })), cancel], { concurrency: 2 });
      const lent = yield* es.exists(BookLent.where({ member_id: `m-${cardNumber}` }));
      return { borrow, lent };
    })
  );

const errorOf = (exit: any) => exit.cause?.reasons?.find((r: any) => r._tag === "Fail")?.error;

describe("a lookup in resolve is protected", () => {
  it("strict (a model): the card is cancelled after the lookup, so the append is refused and the re-run finds no member", { timeout: 30_000 }, async () => {
    const { borrow, lent } = await race(true);
    assert.ok(errorOf(borrow) instanceof CardNotValid, `expected CardNotValid, got ${JSON.stringify(borrow)}`);
    assert.equal(lent, false, "no book was lent on a cancelled card");
  });

  it("concurrent (no model): the lookup becomes the guard, with the same result", { timeout: 30_000 }, async () => {
    const { borrow, lent } = await race(false);
    assert.ok(errorOf(borrow) instanceof CardNotValid, `expected CardNotValid, got ${JSON.stringify(borrow)}`);
    assert.equal(lent, false, "no book was lent on a cancelled card");
  });
});
