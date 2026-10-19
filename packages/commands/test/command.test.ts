import { describe, expect, test } from "bun:test";
import { Cause, Effect, Exit } from "effect";
import * as Schema from "effect/Schema";
import { EventStore } from "@crablet/eventstore";
import * as AppendCondition from "@crablet/eventstore/AppendCondition";
import { Duplicate } from "@crablet/eventstore/AppendErrors";
import * as LogPosition from "@crablet/eventstore/LogPosition";
import * as Tag from "@crablet/eventstore/Tag";
import { makeInMemoryEventStore, type InMemoryEventStore } from "@crablet/eventstore/testing/InMemoryEventStore";
import { concurrent, defineCommand, emit, fail, noop, strict } from "../src/Command.ts";
import { DomainError, IdempotencyMismatch, InvalidInput } from "../src/Errors.ts";
import { defineEvent } from "../src/Event.ts";
import { defineModel } from "../src/Model.ts";

// A tiny domain: a counter that can be opened and incremented; incrementing needs it open.
const Opened = defineEvent("Opened", { schema: Schema.Struct({ id: Schema.String }), tags: (d) => ({ counter_id: d.id }) });
const Incremented = defineEvent("Incremented", {
  schema: Schema.Struct({ id: Schema.String, by: Schema.Number, opId: Schema.String }),
  tags: (d) => ({ counter_id: d.id, op_id: d.opId })
});
const CounterModel = defineModel({ by: "counter_id", initial: () => ({ open: false, value: 0 }) })
  .lifecycle(Opened, () => ({ open: true, value: 0 }))
  .on(Incremented, (c, d) => ({ ...c, value: c.value + d.by }));

class NotOpen extends DomainError("NotOpen", { fields: { id: Schema.String }, kind: "not_found" }) {}
class TooLarge extends DomainError("TooLarge", { fields: { max: Schema.Number }, kind: "invalid" }) {}

const Positive = Schema.Number.check(Schema.isGreaterThan(0));
const input = Schema.Struct({ id: Schema.String, by: Positive, opId: Schema.String });

const Increment = defineCommand({
  name: "increment",
  errors: [NotOpen, TooLarge],
  input,
  model: (c) => CounterModel.of({ id: c.id }),
  decide: (counter, c) =>
    !counter.open
      ? fail(new NotOpen({ id: c.id }))
      : counter.value + c.by > 100
        ? fail(new TooLarge({ max: 100 }))
        : emit(Incremented(c))
});

const cmd = { id: "c1", by: 5, opId: "op1" };
const open = (fake: InMemoryEventStore, id = "c1") => fake.seed(Opened({ id }));
const runHandler = <A, E>(fake: InMemoryEventStore, effect: Effect.Effect<A, E, EventStore>) =>
  Effect.runPromiseExit(Effect.provideService(effect, EventStore, fake.service));
const succeeded = async <A, E>(fake: InMemoryEventStore, effect: Effect.Effect<A, E, EventStore>): Promise<A> => {
  const exit = await runHandler(fake, effect);
  if (Exit.isFailure(exit)) throw new Error(`expected success, got ${Cause.pretty(exit.cause)}`);
  return exit.value;
};
const failureOf = async <A, E>(fake: InMemoryEventStore, effect: Effect.Effect<A, E, EventStore>): Promise<unknown> => {
  const exit = await runHandler(fake, effect);
  if (Exit.isSuccess(exit)) throw new Error("expected failure");
  return exit.cause.reasons.find(Cause.isFailReason)?.error;
};

describe("defineCommand: the decision", () => {
  test("a refusal from decide is a typed failure; a pure decide never touches the store", async () => {
    const fake = makeInMemoryEventStore();
    expect(await failureOf(fake, Increment.handler(cmd))).toBeInstanceOf(NotOpen);
    open(fake);
    expect(await failureOf(fake, Increment.handler({ ...cmd, by: 101 }))).toBeInstanceOf(TooLarge);
    expect(fake.appended).toHaveLength(0);
  });

  test("emit becomes an Append of those events", async () => {
    const fake = makeInMemoryEventStore();
    open(fake);
    const decision = await succeeded(fake, Increment.handler(cmd));
    expect(decision._tag).toBe("Append");
    if (decision._tag === "Append") {
      expect(decision.events).toHaveLength(1);
      expect(decision.events[0]!.type).toBe("Incremented");
    }
  });

  test("noop, and emitting nothing, are no-ops (nothing to append)", async () => {
    const fake = makeInMemoryEventStore();
    const Nothing = defineCommand({ name: "n", input, decide: () => noop("not needed") });
    expect(await succeeded(fake, Nothing.handler(cmd))).toEqual({ _tag: "NoOp", reason: "not needed", marker: null }); // no model: nothing to point at
    const Empty = defineCommand({ name: "e", input, decide: () => emit() });
    expect(await succeeded(fake, Empty.handler(cmd))).toEqual({ _tag: "NoOp", reason: "NO_EVENTS", marker: null });
  });
});

describe("defineCommand: consistency -> append condition", () => {
  const condOf = async (command: { handler: (i: any) => Effect.Effect<any, any, EventStore> }, fake: InMemoryEventStore) => {
    const d = await succeeded(fake, command.handler(cmd));
    if (d._tag !== "Append") throw new Error("expected Append");
    return d;
  };

  test("strict (the default): fail if anything in the model's boundary changed since load", async () => {
    const fake = makeInMemoryEventStore();
    open(fake); // position 1 is the newest event in the boundary
    const d = await condOf(Increment, fake);
    const model = CounterModel.of({ id: "c1" });
    expect(d.condition.concurrencyQuery).toEqual(model.query);
    expect(d.condition.afterPosition.position).toBe(1n);
    expect(d.condition.idempotencyQuery.items).toHaveLength(0);
    expect(d.conflictKind).toBe("boundary");
  });

  test("concurrent(): no concurrency check at all", async () => {
    const fake = makeInMemoryEventStore();
    open(fake);
    const C = defineCommand({ name: "c", input, model: (c) => CounterModel.of({ id: c.id }), consistency: () => concurrent(), decide: (_, c) => emit(Incremented(c)) });
    const d = await condOf(C, fake);
    expect(d.condition).toEqual(AppendCondition.empty());
  });

  test("concurrent({ guard }): only the guard's events conflict, checked after the loaded position", async () => {
    const fake = makeInMemoryEventStore();
    open(fake);
    const guard = CounterModel.lifecycleQuery("c1");
    const C = defineCommand({ name: "c", input, model: (c) => CounterModel.of({ id: c.id }), consistency: () => concurrent({ guard }), decide: (_, c) => emit(Incremented(c)) });
    const d = await condOf(C, fake);
    expect(d.condition.concurrencyQuery).toEqual(guard);
    expect(d.condition.afterPosition.position).toBe(1n);
    expect(d.conflictKind).toBe("guard");
  });

  test("a guard that includes an event type the command appends is rejected", async () => {
    const fake = makeInMemoryEventStore();
    open(fake);
    const C = defineCommand({
      name: "c",
      input,
      model: (c) => CounterModel.of({ id: c.id }),
      consistency: (c) => concurrent({ guard: Incremented.where({ counter_id: c.id }) }),
      decide: (_, c) => emit(Incremented(c))
    });
    const exit = await runHandler(fake, C.handler(cmd));
    expect(Exit.isFailure(exit) && exit.cause.reasons.some(Cause.isDieReason)).toBe(true);
  });

  test("a model-less command defaults to concurrent()", async () => {
    const fake = makeInMemoryEventStore();
    const Record = defineCommand({ name: "r", input, decide: (state, c) => (state === undefined ? emit(Incremented(c)) : noop()) });
    const d = await condOf(Record, fake);
    expect(d.condition).toEqual(AppendCondition.empty());
  });

  test("strict consistency without a model is a defect (there is no boundary to be strict about)", async () => {
    const fake = makeInMemoryEventStore();
    const Bad = defineCommand({ name: "bad", input, consistency: () => strict(), decide: (_, c) => emit(Incremented(c)) });
    const exit = await runHandler(fake, Bad.handler(cmd));
    expect(Exit.isFailure(exit) && exit.cause.reasons.some(Cause.isDieReason)).toBe(true);
  });
});

describe("defineCommand: idempotency", () => {
  const withIdem = (extra: Partial<{ consistency: () => ReturnType<typeof strict> }> = {}) =>
    defineCommand({
      name: "inc",
      input,
      model: (c) => CounterModel.of({ id: c.id }),
      idempotentBy: (c) => Incremented.where({ op_id: c.opId }),
      decide: (_, c) => emit(Incremented(c)),
      ...extra
    });

  test("every combination of consistency and idempotency maps to the expected AppendCondition", async () => {
    const fake = makeInMemoryEventStore();
    open(fake);
    const pos = LogPosition.of(1n, new Date(), "1");
    const model = CounterModel.of({ id: "c1" });
    const idem = Incremented.where({ op_id: "op1" });
    const guard = CounterModel.lifecycleQuery("c1");
    const cond = async (consistency: () => any, idempotent: boolean) => {
      const C = defineCommand({
        name: "x",
        input,
        model: (c) => CounterModel.of({ id: c.id }),
        consistency,
        ...(idempotent ? { idempotentBy: (c: { opId: string }) => Incremented.where({ op_id: c.opId }) } : {}),
        decide: (_: unknown, c: any) => emit(Incremented(c))
      });
      const d = await succeeded(fake, C.handler(cmd));
      return d._tag === "Append" ? d.condition : null;
    };
    const eq = (a: AppendCondition.AppendCondition | null, b: AppendCondition.AppendCondition) =>
      expect({ ...a, afterPosition: a!.afterPosition.position }).toEqual({ ...b, afterPosition: b.afterPosition.position });

    eq(await cond(() => strict(), false), AppendCondition.of(pos, model.query));
    eq(await cond(() => strict(), true), AppendCondition.of(pos, model.query, idem)); // strict AND idempotent
    eq(await cond(() => concurrent(), false), AppendCondition.empty());
    eq(await cond(() => concurrent(), true), AppendCondition.idempotentFromQuery(idem));
    eq(await cond(() => concurrent({ guard }), false), AppendCondition.of(pos, guard));
    eq(await cond(() => concurrent({ guard }), true), AppendCondition.of(pos, guard, idem));
  });

  test("the check runs BEFORE resolve and decide: a repeat neither re-resolves nor re-decides", async () => {
    const fake = makeInMemoryEventStore();
    open(fake);
    fake.seed(Incremented({ id: "c1", by: 1, opId: "op1" })); // the operation was already done
    const calls: Array<string> = [];
    const C = defineCommand({
      name: "inc",
      input,
      resolve: () => Effect.sync(() => void calls.push("resolve")),
      model: (c) => CounterModel.of({ id: c.id }),
      idempotentBy: (c) => Incremented.where({ op_id: c.opId }),
      decide: (_, c) => (calls.push("decide"), emit(Incremented(c)))
    });
    expect(await succeeded(fake, C.handler(cmd))).toEqual({ _tag: "NoOp", reason: "DUPLICATE_OPERATION", marker: { position: 2n, transactionId: "2" } }); // the earlier write
    expect(calls).toEqual([]);
  });

  test("an append with an idempotency query carries it; an append without one has none", async () => {
    const fake = makeInMemoryEventStore();
    open(fake);
    const idem = await succeeded(fake, withIdem().handler(cmd));
    expect(idem._tag === "Append" && idem.condition.idempotencyQuery !== undefined && idem.condition.idempotencyQuery !== null).toBe(true);
  });
});

describe("defineCommand: resolve", () => {
  // A lookup: a card names a counter. The command is given the card; the model it decides on is the counter's.
  const CardIssued = defineEvent("CardIssued", { schema: Schema.Struct({ card: Schema.String, counter: Schema.String }), tags: (d) => ({ card_number: d.card }) });
  const CardModel = defineModel({ by: "card_number", initial: () => ({ counter: null as string | null }) }).on(CardIssued, (_, d) => ({ counter: d.counter }));
  const byCard = Schema.Struct({ card: Schema.String, by: Positive, opId: Schema.String });
  const viaCard = { card: "k1", by: 1, opId: "op1" };
  const lookUp = (c: { card: string }, read: import("../src/Command.ts").ResolveReader) => Effect.map(read.load(CardModel.of({ id: c.card })), (card) => card.counter ?? "none");
  const items = (q: { readonly items: ReadonlyArray<unknown> }) => q.items;
  const conditionOf = async (fake: InMemoryEventStore, C: { handler: (i: any) => Effect.Effect<any, any, EventStore> }) => {
    const d = await succeeded(fake, C.handler(viaCard));
    if (d._tag !== "Append") throw new Error("expected an append");
    return d.condition as AppendCondition.AppendCondition;
  };

  test("runs after the idempotency check, and its result reaches model, consistency and decide as `resolved`", async () => {
    const fake = makeInMemoryEventStore();
    open(fake, "c9");
    fake.seed(CardIssued({ card: "k1", counter: "c9" }));
    const seen: Array<unknown> = [];
    const C = defineCommand({
      name: "r",
      input: byCard,
      resolve: lookUp,
      model: (_, { resolved }) => (seen.push(["model", resolved]), CounterModel.of({ id: resolved })),
      consistency: (_, { resolved }) => (seen.push(["consistency", resolved]), strict()),
      decide: (counter, c, { resolved }) => (seen.push(["decide", resolved, counter.open]), emit(Incremented({ id: resolved, by: c.by, opId: c.opId })))
    });
    await succeeded(fake, C.handler(viaCard));
    expect(seen).toEqual([["model", "c9"], ["decide", "c9", true], ["consistency", "c9"]]);
  });

  test("strict: the condition covers the model's boundary AND what resolve read", async () => {
    const fake = makeInMemoryEventStore();
    open(fake, "c9");
    fake.seed(CardIssued({ card: "k1", counter: "c9" }));
    const C = defineCommand({
      name: "r", input: byCard, resolve: lookUp,
      model: (_, { resolved }) => CounterModel.of({ id: resolved }),
      decide: (_, c, { resolved }) => emit(Incremented({ id: resolved, by: c.by, opId: c.opId }))
    });
    const condition = await conditionOf(fake, C);
    expect(items(condition.concurrencyQuery)).toEqual([...items(CounterModel.of({ id: "c9" }).query), ...items(CardModel.of({ id: "k1" }).query)]);
  });

  test("concurrent with a guard: what resolve read joins the guard", async () => {
    const fake = makeInMemoryEventStore();
    open(fake, "c9");
    fake.seed(CardIssued({ card: "k1", counter: "c9" }));
    const guard = CounterModel.lifecycleQuery("c9");
    const C = defineCommand({
      name: "r", input: byCard, resolve: lookUp,
      model: (_, { resolved }) => CounterModel.of({ id: resolved }),
      consistency: () => concurrent({ guard }),
      decide: (_, c, { resolved }) => emit(Incremented({ id: resolved, by: c.by, opId: c.opId }))
    });
    const condition = await conditionOf(fake, C);
    expect(items(condition.concurrencyQuery)).toEqual([...items(guard), ...items(CardModel.of({ id: "k1" }).query)]);
  });

  test("concurrent without a guard, and no model: what resolve read becomes the guard", async () => {
    const fake = makeInMemoryEventStore();
    fake.seed(CardIssued({ card: "k1", counter: "c9" }));
    const C = defineCommand({
      name: "r", input: byCard, resolve: lookUp,
      decide: (_, c, { resolved }) => emit(Incremented({ id: resolved, by: c.by, opId: c.opId }))
    });
    const condition = await conditionOf(fake, C);
    expect(items(condition.concurrencyQuery)).toEqual(items(CardModel.of({ id: "k1" }).query));
  });

  test("exists reads join the condition too", async () => {
    const fake = makeInMemoryEventStore();
    fake.seed(CardIssued({ card: "k1", counter: "c9" }));
    const issued = CardIssued.where({ card_number: "k1" });
    const C = defineCommand({
      name: "r", input: byCard,
      resolve: (c, read) => read.exists(CardIssued.where({ card_number: c.card })),
      decide: (_, c, { resolved }) => (resolved ? emit(Incremented({ id: "c9", by: c.by, opId: c.opId })) : noop())
    });
    const condition = await conditionOf(fake, C);
    expect(items(condition.concurrencyQuery)).toEqual(items(issued));
  });

  test("a lookup over an event the command appends cannot be a guard, so the condition is strict over it (and nothing throws)", async () => {
    const fake = makeInMemoryEventStore();
    open(fake, "c9");
    const C = defineCommand({
      name: "r", input: byCard,
      resolve: (_, read) => Effect.map(read.load(CounterModel.of({ id: "c9" })), (c) => c.value),
      consistency: () => concurrent(),
      decide: (_, c) => emit(Incremented({ id: "c9", by: c.by, opId: c.opId }))
    });
    const condition = await conditionOf(fake, C);
    expect(items(condition.concurrencyQuery)).toEqual(items(CounterModel.of({ id: "c9" }).query));
  });

  test("the reader cannot write", () => {
    defineCommand({
      name: "r", input: byCard,
      // @ts-expect-error - a ResolveReader has no append
      resolve: (c, read) => read.append([CardIssued({ card: c.card, counter: "x" })]),
      decide: () => noop()
    });
    expect(true).toBe(true);
  });

  test("a failure in resolve is the command's failure", async () => {
    const fake = makeInMemoryEventStore();
    const C = defineCommand({ name: "r", input, resolve: () => Effect.fail("nope" as const), decide: () => noop() });
    expect(await failureOf(fake, C.handler(cmd))).toBe("nope");
  });
});

describe("defineCommand: input", () => {
  test("decodeInput accepts valid input and rejects invalid input with InvalidInput", async () => {
    expect(await Effect.runPromise(Increment.decodeInput(cmd))).toEqual(cmd);
    const bad = await Effect.runPromiseExit(Increment.decodeInput({ ...cmd, by: -1 }));
    expect(Exit.isFailure(bad) && bad.cause.reasons.find(Cause.isFailReason)?.error).toBeInstanceOf(InvalidInput);
    const missing = await Effect.runPromiseExit(Increment.decodeInput({ id: "c1" }));
    expect(Exit.isFailure(missing)).toBe(true);
  });

  test("defaults: 3 conflict retries", () => {
    expect(Increment.retries).toBe(3);
    expect(Increment.name).toBe("increment");
    expect(defineCommand({ name: "x", input, retries: 0, decide: () => noop() }).retries).toBe(0);
  });
});

// ---- compile-time: the error type is inferred from decide/resolve, never written by hand ----------
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
const assertType = <_T extends true>() => {};
type HandlerErr<C extends { handler: (...a: any[]) => Effect.Effect<any, any, any> }> = Effect.Error<ReturnType<C["handler"]>>;

describe("defineCommand: name", () => {
  test("must be 1-64 characters (the command audit stores it in a column of that size): fail at definition, not mid-request", () => {
    expect(() => defineCommand({ name: "x".repeat(65), input, decide: () => noop() })).toThrow(/1-64 characters/);
    expect(() => defineCommand({ name: "", input, decide: () => noop() })).toThrow(/1-64 characters/);
    expect(defineCommand({ name: "x".repeat(64), input, decide: () => noop() }).name).toHaveLength(64);
  });
});

describe("defineCommand: declared errors", () => {
  class Other extends DomainError("Other", { fields: {}, kind: "invalid" }) {}
  const failsWith = (id: string) => (id === "a" ? fail(new NotOpen({ id })) : fail(new TooLarge({ max: 1 })));

  test("the declared classes are carried on the command, with their kind, tag and fields", () => {
    expect(Increment.errors).toEqual([NotOpen, TooLarge]);
    expect(Increment.errors.map((e) => `${e.tag}:${e.kind}`)).toEqual(["NotOpen:not_found", "TooLarge:invalid"]);
    expect(Object.keys(Increment.errors[0]!.fields)).toEqual(["id"]);
  });

  test("a command with no domain errors declares none", () => {
    expect(defineCommand({ name: "none", input, decide: () => noop() }).errors).toEqual([]);
  });

  test("decide cannot fail with a domain error that is not declared (the compile error names the class)", () => {
    // @ts-expect-error - TooLarge is not declared (undeclaredDomainErrors: TooLarge)
    defineCommand({ name: "x", input, errors: [NotOpen], decide: (_, c) => failsWith(c.id) });
    // @ts-expect-error - nothing declared although decide fails with domain errors
    defineCommand({ name: "x", input, decide: (_, c) => failsWith(c.id) });
    // extra declared classes are fine
    expect(defineCommand({ name: "x", input, errors: [NotOpen, TooLarge, Other], decide: (_, c) => failsWith(c.id) }).errors).toHaveLength(3);
  });

  test("resolve cannot fail with an undeclared domain error either", () => {
    // @ts-expect-error - NotOpen is not declared
    defineCommand({ name: "p", input, resolve: (c) => Effect.fail(new NotOpen({ id: c.id })), decide: () => noop() });
    expect(
      defineCommand({ name: "p", input, errors: [NotOpen], resolve: (c) => Effect.fail(new NotOpen({ id: c.id })), decide: () => noop() }).errors
    ).toEqual([NotOpen]);
  });

  test("errors that are not domain errors need no declaration", () => {
    expect(defineCommand({ name: "plain", input, decide: () => fail("just a string" as const) }).errors).toEqual([]);
  });
});

describe("defineCommand: inferred types", () => {
  test("the handler's failures are exactly what decide can fail with (plus SqlError from the store and IdempotencyMismatch, the framework's refusal of a reused key)", () => {
    type SqlErr = import("effect/sql/SqlError").SqlError;
    assertType<Equal<HandlerErr<typeof Increment>, NotOpen | TooLarge | SqlErr | IdempotencyMismatch>>();
    // a refusal type that decide cannot produce is NOT in the union
    assertType<Equal<(typeof Increment)["handler"] extends (...a: any[]) => Effect.Effect<any, infer E, any> ? (Duplicate extends E ? true : false) : never, false>>();
    // a repeat found by idempotentBy is a success, never a failure; resolve's failures are added
    const WithIdem = defineCommand({ name: "d", input, idempotentBy: (c) => Incremented.where({ op_id: c.opId }), decide: () => noop() });
    assertType<Equal<(Duplicate extends HandlerErr<typeof WithIdem> ? true : false), false>>();
    const WithResolve = defineCommand({ name: "p", input, resolve: () => Effect.fail("boom" as const), decide: () => noop() });
    assertType<Equal<(("boom") extends HandlerErr<typeof WithResolve> ? true : false), true>>();
    // the input type comes from the schema
    const typed: Parameters<typeof Increment.handler>[0] = { id: "x", by: 1, opId: "y" };
    expect(typed.by).toBe(1);
  });
});

test("DomainError carries kind and fields and is catchable by tag", async () => {
  const error = new NotOpen({ id: "c1" });
  expect(error._tag).toBe("NotOpen");
  expect(error.id).toBe("c1");
  expect(NotOpen.kind).toBe("not_found");
  expect(TooLarge.kind).toBe("invalid");
  const recovered = await Effect.runPromise(Effect.fail(error).pipe(Effect.catchTag("NotOpen", (e) => Effect.succeed(e.id))));
  expect(recovered).toBe("c1");
  expect(Tag.of("a", "b").key).toBe("a"); // keep the Tag import honest
});
