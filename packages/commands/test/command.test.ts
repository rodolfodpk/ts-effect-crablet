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
import { DomainError, InvalidInput } from "../src/Errors.ts";
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
    expect(await succeeded(fake, Nothing.handler(cmd))).toEqual({ _tag: "NoOp", reason: "not needed" });
    const Empty = defineCommand({ name: "e", input, decide: () => emit() });
    expect(await succeeded(fake, Empty.handler(cmd))).toEqual({ _tag: "NoOp", reason: "NO_EVENTS" });
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
  const withIdem = (extra: Partial<{ consistency: () => ReturnType<typeof strict>; onDuplicate: "return" | "fail" }> = {}) =>
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

  test("the check runs BEFORE prepare and decide: a repeat neither re-prepares nor re-decides", async () => {
    const fake = makeInMemoryEventStore();
    open(fake);
    fake.seed(Incremented({ id: "c1", by: 1, opId: "op1" })); // the operation was already done
    const calls: Array<string> = [];
    const C = defineCommand({
      name: "inc",
      input,
      prepare: () => Effect.sync(() => void calls.push("prepare")),
      model: (c) => CounterModel.of({ id: c.id }),
      idempotentBy: (c) => Incremented.where({ op_id: c.opId }),
      decide: (_, c) => (calls.push("decide"), emit(Incremented(c)))
    });
    expect(await succeeded(fake, C.handler(cmd))).toEqual({ _tag: "NoOp", reason: "DUPLICATE_OPERATION" });
    expect(calls).toEqual([]);
  });

  test('onDuplicate "fail": a repeat fails with Duplicate instead', async () => {
    const fake = makeInMemoryEventStore();
    open(fake);
    fake.seed(Incremented({ id: "c1", by: 1, opId: "op1" }));
    const C = withIdem({ onDuplicate: "fail" });
    expect(await failureOf(fake, C.handler(cmd))).toBeInstanceOf(Duplicate);
    expect(C.duplicates).toBe("fail");
  });

  test('an append built for onDuplicate "fail" tells the executor to throw; the default returns', async () => {
    const fake = makeInMemoryEventStore();
    open(fake);
    const fail_ = await succeeded(fake, withIdem({ onDuplicate: "fail" }).handler(cmd));
    const ret = await succeeded(fake, withIdem().handler(cmd));
    expect(fail_._tag === "Append" && fail_.onDuplicate).toBe("THROW");
    expect(ret._tag === "Append" && ret.onDuplicate).toBe("RETURN_IDEMPOTENT");
  });
});

describe("defineCommand: prepare", () => {
  test("runs after the idempotency check, sees the input and the store, and feeds model and decide", async () => {
    const fake = makeInMemoryEventStore();
    open(fake, "c9");
    const seen: Array<unknown> = [];
    const C = defineCommand({
      name: "p",
      input,
      prepare: (c, es) => Effect.map(es.exists(CounterModel.lifecycleQuery(c.id)), (exists) => ({ target: "c9", exists })),
      model: (c, p) => (seen.push(["model", p]), CounterModel.of({ id: p.target })),
      decide: (counter, c, p) => (seen.push(["decide", p, counter.open]), emit(Incremented({ ...c, id: p.target })))
    });
    await succeeded(fake, C.handler(cmd));
    expect(seen).toEqual([["model", { target: "c9", exists: false }], ["decide", { target: "c9", exists: false }, true]]);
  });

  test("a failure in prepare is the command's failure", async () => {
    const fake = makeInMemoryEventStore();
    const C = defineCommand({ name: "p", input, prepare: () => Effect.fail("nope" as const), decide: () => noop() });
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

  test("defaults: 3 conflict retries, repeats are idempotent successes", () => {
    expect(Increment.retries).toBe(3);
    expect(Increment.duplicates).toBe("return");
    expect(Increment.name).toBe("increment");
    expect(defineCommand({ name: "x", input, retries: 0, decide: () => noop() }).retries).toBe(0);
  });
});

// ---- compile-time: the error type is inferred from decide/prepare, never written by hand ----------
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
const assertType = <_T extends true>() => {};
type HandlerErr<C extends { handler: (...a: any[]) => Effect.Effect<any, any, any> }> = Effect.Error<ReturnType<C["handler"]>>;

describe("defineCommand: inferred types", () => {
  test("the handler's failures are exactly what decide can fail with (plus SqlError from the store)", () => {
    type SqlErr = import("effect/sql/SqlError").SqlError;
    assertType<Equal<HandlerErr<typeof Increment>, NotOpen | TooLarge | SqlErr>>();
    // a refusal type that decide cannot produce is NOT in the union
    assertType<Equal<(typeof Increment)["handler"] extends (...a: any[]) => Effect.Effect<any, infer E, any> ? (Duplicate extends E ? true : false) : never, false>>();
    // onDuplicate: "fail" adds Duplicate; prepare's failures are added too
    const WithDup = defineCommand({ name: "d", input, onDuplicate: "fail", decide: () => noop() });
    assertType<Equal<(Duplicate extends HandlerErr<typeof WithDup> ? true : false), true>>();
    const WithPrepare = defineCommand({ name: "p", input, prepare: () => Effect.fail("boom" as const), decide: () => noop() });
    assertType<Equal<(("boom") extends HandlerErr<typeof WithPrepare> ? true : false), true>>();
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
