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
import { DomainError } from "../../src/Errors.ts";
import { defineEvent } from "../../src/Event.ts";
import { defineModel } from "../../src/Model.ts";

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

// A library: a card names a member; a loan is the member's.
const CardIssued = defineEvent("RL_CardIssued", { schema: Schema.Struct({ card: Schema.String, member: Schema.String }), tags: (d) => ({ card_number: d.card }) });
const CardCancelled = defineEvent("RL_CardCancelled", { schema: Schema.Struct({ card: Schema.String }), tags: (d) => ({ card_number: d.card }) });
const BookLent = defineEvent("RL_BookLent", { schema: Schema.Struct({ member: Schema.String, book: Schema.String }), tags: (d) => ({ member_id: d.member }) });
const CardModel = defineModel({ by: "card_number", initial: () => ({ member: null as string | null }) })
  .on(CardIssued, (_, d) => ({ member: d.member }))
  .on(CardCancelled, () => ({ member: null }));
const MemberModel = defineModel({ by: "member_id", initial: () => ({ loans: 0 }) }).on(BookLent, (m) => ({ loans: m.loans + 1 }));
class CardNotValid extends DomainError("CardNotValid", { fields: { card: Schema.String }, kind: "invalid" }) {}

const input = Schema.Struct({ card: Schema.String, book: Schema.String });

// The command looks the card up, then waits (only on its first attempt) until the test has cancelled the card.
const lookUp = (lookedUp: Deferred.Deferred<void>, cancelled: Deferred.Deferred<void>) => (c: { readonly card: string }, read: ResolveReader) =>
  Effect.gen(function* () {
    const card = yield* read.load(CardModel.of({ id: c.card }));
    if (yield* Deferred.succeed(lookedUp, undefined)) yield* Deferred.await(cancelled);
    return card.member;
  });
const lend = (c: { readonly card: string; readonly book: string }, member: string | null) =>
  member === null ? fail(new CardNotValid({ card: c.card })) : emit(BookLent({ member, book: c.book }));

const borrowBook = (lookedUp: Deferred.Deferred<void>, cancelled: Deferred.Deferred<void>, withModel: boolean) =>
  withModel
    ? defineCommand({
        name: "rl_borrow",
        input,
        errors: [CardNotValid],
        resolve: lookUp(lookedUp, cancelled),
        model: (_, { resolved }) => MemberModel.of({ id: resolved ?? "none" }),
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
      const card = `card-${crypto.randomUUID().slice(0, 8)}`;
      const es = yield* EventStore;
      yield* es.append([CardIssued({ card, member: `m-${card}` })]);
      const lookedUp = yield* Deferred.make<void>();
      const cancelled = yield* Deferred.make<void>();
      const executor = yield* CommandExecutor;
      const cancel = Effect.gen(function* () {
        yield* Deferred.await(lookedUp);
        yield* es.append([CardCancelled({ card })]);
        yield* Deferred.succeed(cancelled, undefined);
      });
      const [borrow] = yield* Effect.all([Effect.exit(executor.run(borrowBook(lookedUp, cancelled, withModel), { card, book: "b1" })), cancel], { concurrency: 2 });
      const lent = yield* es.exists(BookLent.where({ member_id: `m-${card}` }));
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
