import { describe, expect, test } from "bun:test";
import { Cause, Effect, Exit } from "effect";
import * as Schema from "effect/Schema";
import * as Query from "@crablet/eventstore/Query";
import * as Tag from "@crablet/eventstore/Tag";
import { makeInMemoryEventStore } from "@crablet/eventstore/testing/InMemoryEventStore";
import { defineEvent } from "../src/Event.ts";
import { all, defineModel } from "../src/Model.ts";

// A small domain with every feature the model builder has: lifecycle events (not scoped), scoped
// events bound by the default tag, and a two-party event bound through TWO tags.
const Opened = defineEvent("Opened", {
  schema: Schema.Struct({ accountId: Schema.String, initial: Schema.Number }),
  tags: (d) => ({ account_id: d.accountId })
});
const Closed = defineEvent("Closed", {
  schema: Schema.Struct({ accountId: Schema.String }),
  tags: (d) => ({ account_id: d.accountId })
});
const Deposited = defineEvent("Deposited", {
  schema: Schema.Struct({ accountId: Schema.String, amount: Schema.Number }),
  tags: (d) => ({ account_id: d.accountId })
});
const Transferred = defineEvent("Transferred", {
  schema: Schema.Struct({ fromId: Schema.String, toId: Schema.String, amount: Schema.Number }),
  tags: (d) => ({ from_id: d.fromId, to_id: d.toId })
});
const Unrelated = defineEvent("Unrelated", { schema: Schema.Struct({}), tags: () => ({}) });

interface Account {
  readonly open: boolean;
  readonly balance: number;
}

const AccountModel = defineModel({
  by: "account_id",
  initial: (): Account => ({ open: false, balance: 0 }),
  scope: (s: { year: number }) => ({ year: s.year })
})
  .lifecycle(Opened, (_, d) => ({ open: true, balance: d.initial }))
  .lifecycle(Closed, (a) => ({ ...a, open: false }))
  .on(Deposited, (a, d) => ({ ...a, balance: a.balance + d.amount }))
  .on(
    Transferred,
    // the handler context says which account this state is about, and the stored event has both tags
    (a, d, ctx) => ({ ...a, balance: a.balance + (ctx.id === d.toId ? d.amount : -d.amount) }),
    { by: ["from_id", "to_id"] }
  );

const load = <S>(fake: ReturnType<typeof makeInMemoryEventStore>, model: { load: (es: never) => Effect.Effect<S, unknown> }) =>
  Effect.runPromise(model.load(fake.service as never) as Effect.Effect<S>);

describe("defineModel: the boundary query is derived from the handlers", () => {
  test("lifecycle events share one unscoped item; scoped events carry the scope tags; multi-tag events get one item per tag", () => {
    const { query } = AccountModel.of({ id: "a1", year: 2026 });
    expect(query).toEqual(
      Query.of([
        Query.queryItemOf(["Opened", "Closed"], [Tag.of("account_id", "a1")]),
        Query.queryItemOf(["Deposited"], [Tag.of("account_id", "a1"), Tag.of("year", "2026")]),
        Query.queryItemOf(["Transferred"], [Tag.of("from_id", "a1"), Tag.of("year", "2026")]),
        Query.queryItemOf(["Transferred"], [Tag.of("to_id", "a1"), Tag.of("year", "2026")])
      ])
    );
  });

  test("lifecycleQuery is only the lifecycle item - the natural guard query", () => {
    expect(AccountModel.lifecycleQuery("a1")).toEqual(
      Query.of([Query.queryItemOf(["Opened", "Closed"], [Tag.of("account_id", "a1")])])
    );
  });

  test("a model without scope has no scope tags", () => {
    const Plain = defineModel({ by: "k", initial: () => 0 }).on(Deposited, (n, d) => n + d.amount);
    expect(Plain.of({ id: "x" }).query).toEqual(Query.of([Query.queryItemOf(["Deposited"], [Tag.of("k", "x")])]));
  });
});

describe("defineModel: folding", () => {
  test("folds this entity's events, in order, from the initial state", async () => {
    const fake = makeInMemoryEventStore();
    fake.seed(
      Opened({ accountId: "a1", initial: 10 }),
      Deposited({ accountId: "a1", amount: 5 }, [Tag.of("year", "2026")]),
      Deposited({ accountId: "a1", amount: 7 }, [Tag.of("year", "2026")])
    );
    const { state } = await load(fake, AccountModel.of({ id: "a1", year: 2026 }));
    expect(state).toEqual({ open: true, balance: 22 });
  });

  test("ignores other entities, other scopes and unrelated event types", async () => {
    const fake = makeInMemoryEventStore();
    fake.seed(
      Opened({ accountId: "a1", initial: 10 }),
      Opened({ accountId: "a2", initial: 999 }),
      Deposited({ accountId: "a2", amount: 50 }, [Tag.of("year", "2026")]),
      Deposited({ accountId: "a1", amount: 1000 }, [Tag.of("year", "2025")]),
      Unrelated({})
    );
    const { state } = await load(fake, AccountModel.of({ id: "a1", year: 2026 }));
    expect(state).toEqual({ open: true, balance: 10 });
  });

  test("lifecycle events apply regardless of scope", async () => {
    const fake = makeInMemoryEventStore();
    fake.seed(Opened({ accountId: "a1", initial: 10 }), Closed({ accountId: "a1" }));
    const { state } = await load(fake, AccountModel.of({ id: "a1", year: 2031 }));
    expect(state.open).toBe(false);
  });

  test("a two-party event is applied from each side using the instance id and the event's tags", async () => {
    const fake = makeInMemoryEventStore();
    fake.seed(
      Opened({ accountId: "a", initial: 100 }),
      Opened({ accountId: "b", initial: 0 }),
      Transferred({ fromId: "a", toId: "b", amount: 40 }, [Tag.of("year", "2026")])
    );
    expect((await load(fake, AccountModel.of({ id: "a", year: 2026 }))).state.balance).toBe(60);
    expect((await load(fake, AccountModel.of({ id: "b", year: 2026 }))).state.balance).toBe(40);
  });

  test("no matching events: initial state, and the zero log position", async () => {
    const fake = makeInMemoryEventStore();
    const loaded = await load(fake, AccountModel.of({ id: "nobody", year: 2026 }));
    expect(loaded.state).toEqual({ open: false, balance: 0 });
    expect(loaded.logPosition.position).toBe(0n);
  });
});

describe("defineModel: log position", () => {
  test("is the position of the newest event IN the boundary, not of unrelated newer events", async () => {
    const fake = makeInMemoryEventStore();
    fake.seed(Opened({ accountId: "a1", initial: 1 })); // position 1, in the boundary
    fake.seed(Opened({ accountId: "other", initial: 1 }), Unrelated({})); // positions 2, 3: not in it
    const { logPosition } = await load(fake, AccountModel.of({ id: "a1", year: 2026 }));
    expect(logPosition.position).toBe(1n);
  });
});

describe("all: a model over several entities", () => {
  test("one boundary (union of the members'), one position, each member's own state", async () => {
    const fake = makeInMemoryEventStore();
    fake.seed(
      Opened({ accountId: "a", initial: 100 }), // 1
      Opened({ accountId: "b", initial: 0 }), // 2
      Transferred({ fromId: "a", toId: "b", amount: 40 }, [Tag.of("year", "2026")]), // 3
      Opened({ accountId: "unrelated", initial: 1 }) // 4
    );
    const from = AccountModel.of({ id: "a", year: 2026 });
    const to = AccountModel.of({ id: "b", year: 2026 });
    const both = all({ from, to });

    expect(both.query.items).toEqual([...from.query.items, ...to.query.items]);
    const { state, logPosition } = await load(fake, both);
    expect(state.from.balance).toBe(60);
    expect(state.to.balance).toBe(40);
    // the newest event in EITHER member's boundary
    expect(logPosition.position).toBe(3n);
  });

  test("the position covers events that only one member's boundary contains", async () => {
    const fake = makeInMemoryEventStore();
    fake.seed(Opened({ accountId: "a", initial: 1 }), Closed({ accountId: "b" }));
    const { logPosition } = await load(fake, all({ x: AccountModel.of({ id: "a", year: 1 }), y: AccountModel.of({ id: "b", year: 1 }) }));
    expect(logPosition.position).toBe(2n);
  });
});

describe("malformed stored data", () => {
  test("an event whose payload does not match its definition is a defect, not a silent skip", async () => {
    const fake = makeInMemoryEventStore();
    fake.seed({ type: "Opened", tags: [Tag.of("account_id", "a1")], eventData: { accountId: "a1" } }); // missing `initial`
    const exit = await Effect.runPromiseExit(AccountModel.of({ id: "a1", year: 2026 }).load(fake.service));
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) expect(exit.cause.reasons.some(Cause.isDieReason)).toBe(true);
  });
});
