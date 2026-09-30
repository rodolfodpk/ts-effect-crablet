import { describe, expect, test } from "bun:test";
import { Cause, Effect, Exit } from "effect";
import { EventStore } from "../src/EventStore.ts";
import * as AppendCondition from "../src/AppendCondition.ts";
import * as AppendEvent from "../src/AppendEvent.ts";
import * as CorrelationContext from "../src/CorrelationContext.ts";
import * as LogPosition from "../src/LogPosition.ts";
import * as Query from "../src/Query.ts";
import { makeInMemoryEventStore } from "../src/testing/InMemoryEventStore.ts";

// Behaviour specific to the in-memory store. What it must share with Postgres (conditions, reads,
// idempotency, data round-trips) is covered by the conformance suite.
const ev = (type: string, key = "k", value = "v") => AppendEvent.of(type, key, value, { type });
const types = (store: ReturnType<typeof makeInMemoryEventStore>) => store.log.map((e) => e.type);
const provide = <A, E>(store: ReturnType<typeof makeInMemoryEventStore>, effect: Effect.Effect<A, E, EventStore>) =>
  Effect.provide(effect, store.layer);

describe("InMemoryEventStore: bookkeeping", () => {
  test("seed stores events without recording an append; append records accepted calls with their condition", async () => {
    const store = makeInMemoryEventStore();
    store.seed(ev("Seeded"));
    const condition = AppendCondition.of(LogPosition.zero(), Query.forEvent("Nothing"));
    await Effect.runPromise(provide(store, Effect.flatMap(EventStore, (es) => es.append([ev("Appended")], condition))));
    expect(types(store)).toEqual(["Seeded", "Appended"]);
    expect(store.appended).toHaveLength(1);
    expect(store.appended[0]!.condition).toBe(condition);
    expect(store.log.map((e) => e.position)).toEqual([1n, 2n]);
  });

  test("a REFUSED append is not recorded and stores nothing", async () => {
    const store = makeInMemoryEventStore();
    store.seed(ev("Existing", "op", "1"));
    const refused = await Effect.runPromise(
      provide(
        store,
        Effect.flatMap(EventStore, (es) =>
          Effect.exit(es.append([ev("Again", "op", "1")], AppendCondition.idempotentFromQuery(Query.forEventAndTag("Existing", "op", "1"))))
        )
      )
    );
    expect(Exit.isFailure(refused)).toBe(true);
    expect(types(store)).toEqual(["Existing"]);
    expect(store.appended).toHaveLength(0);
  });

  test("events carry the ambient correlation and causation ids, like the real store", async () => {
    const store = makeInMemoryEventStore();
    await Effect.runPromise(
      provide(
        store,
        CorrelationContext.withCausationId(7n)(CorrelationContext.withCorrelationId("corr-1")(Effect.flatMap(EventStore, (es) => es.append([ev("Traced")]))))
      )
    );
    await Effect.runPromise(provide(store, Effect.flatMap(EventStore, (es) => es.append([ev("Untraced")]))));
    expect(store.log.map((e) => [e.correlationId, e.causationId])).toEqual([["corr-1", 7n], [null, null]]);
  });

  test("events appended in one call share a transaction id; separate calls do not", async () => {
    const store = makeInMemoryEventStore();
    await Effect.runPromise(provide(store, Effect.flatMap(EventStore, (es) => Effect.andThen(es.append([ev("A"), ev("B")]), es.append([ev("C")])))));
    const [a, b, c] = store.log;
    expect(a!.transactionId).toBe(b!.transactionId);
    expect(c!.transactionId).not.toBe(a!.transactionId);
  });
});

describe("InMemoryEventStore: transaction", () => {
  const appendIn = (store: ReturnType<typeof makeInMemoryEventStore>, type: string) =>
    Effect.flatMap(EventStore, (es) => es.append([ev(type)]));

  test("a successful transaction keeps what it appended", async () => {
    const store = makeInMemoryEventStore();
    await Effect.runPromise(provide(store, store.transaction(appendIn(store, "Kept"))));
    expect(types(store)).toEqual(["Kept"]);
  });

  test("a failed transaction rolls back everything it appended (and what it recorded)", async () => {
    const store = makeInMemoryEventStore();
    store.seed(ev("Before"));
    const exit = await Effect.runPromiseExit(
      provide(store, store.transaction(Effect.andThen(appendIn(store, "Doomed"), Effect.fail("nope"))))
    );
    expect(Exit.isFailure(exit)).toBe(true);
    expect(types(store)).toEqual(["Before"]);
    expect(store.appended).toHaveLength(0);
  });

  test("a DEFECT inside a transaction also rolls back", async () => {
    const store = makeInMemoryEventStore();
    const exit = await Effect.runPromiseExit(
      provide(store, store.transaction(Effect.andThen(appendIn(store, "Doomed"), Effect.die("bug"))))
    );
    expect(Exit.isFailure(exit) && exit.cause.reasons.some(Cause.isDieReason)).toBe(true);
    expect(types(store)).toEqual([]);
  });

  test("an interrupted transaction rolls back", async () => {
    const store = makeInMemoryEventStore();
    const fiber = Effect.runFork(provide(store, store.transaction(Effect.andThen(appendIn(store, "Doomed"), Effect.never))));
    await new Promise((resolve) => setTimeout(resolve, 20));
    await Effect.runPromise(Effect.sync(() => fiber.interruptUnsafe()));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(types(store)).toEqual([]);
  });

  test("transactions are exclusive: two running at once never interleave", async () => {
    const store = makeInMemoryEventStore();
    const steps: Array<string> = [];
    const slow = (name: string) =>
      store.transaction(
        Effect.gen(function* () {
          steps.push(`${name}:start`);
          yield* Effect.sleep("10 millis");
          steps.push(`${name}:end`);
        })
      );
    await Effect.runPromise(Effect.all([slow("a"), slow("b")], { concurrency: 2 }));
    expect(steps).toEqual(["a:start", "a:end", "b:start", "b:end"]);
  });
});

test("appending no events is a defect, like Postgres", async () => {
  const store = makeInMemoryEventStore();
  const exit = await Effect.runPromiseExit(provide(store, Effect.flatMap(EventStore, (es) => es.append([]))));
  expect(Exit.isFailure(exit) && exit.cause.reasons.some(Cause.isDieReason)).toBe(true);
});
