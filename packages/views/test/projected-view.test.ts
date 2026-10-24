import { describe, expect, test } from "bun:test";
import { Effect, DateTime } from "effect";
import type { StoredEvent } from "@crablet/eventstore";
import { EventDecodingError } from "@crablet/eventstore/EventDecoding";
import type { ViewEvent } from "../src/ProjectedView.ts";
import { defineView } from "../src/ProjectedView.ts";
import { applyInMemory, rowsOf } from "../src/ViewMemory.ts";
import { decimal, integer, text, timestamptz, viewTable } from "../src/ViewTable.ts";

// A view needs only `type` and `decodeStored` of an event definition (what `defineEvent` gives), so the tests do not depend on @crablet/commands.
// `read` turns the stored payload into the decoded one, as a schema would (an instant's text into a DateTime).
const eventOf = <D>(type: string, valid: (raw: any) => boolean, read: (raw: any) => D = (raw) => raw): ViewEvent<D> => ({
  type,
  decodeStored: (event) =>
    valid(event.data)
      ? Effect.succeed(read(event.data))
      : Effect.fail(new EventDecodingError({ message: "cannot be read", type, position: event.position, transactionId: event.transactionId, issues: [] }))
});
const Opened = eventOf<{ id: string; balance: number }>("Opened", (d) => typeof d.id === "string" && typeof d.balance === "number");
const Deposited = eventOf<{ id: string; amount: number; at: DateTime.Utc }>("Deposited", (d) => typeof d.amount === "number", (d) => ({ ...d, at: DateTime.makeUnsafe(d.at) }));
const Closed = eventOf<{ id: string }>("Closed", (d) => typeof d.id === "string");

const accounts = viewTable("accounts", {
  key: { id: text() },
  columns: { balance: decimal().default(0), deposits: integer().default(0), last_at: timestamptz().nullable() }
});

const view = defineView("accounts-view", { tables: [accounts] })
  .on(Opened, (d) => accounts.insert({ id: d.id, balance: d.balance }, { onConflict: "replace" }))
  .on(Deposited, (d) => accounts.upsert({ id: d.id }, { add: { balance: d.amount, deposits: 1 }, max: { last_at: d.at } }))
  .on(Closed, (d) => [accounts.remove({ id: d.id }), undefined]);

let position = 0n;
const stored = (type: string, data: unknown): StoredEvent =>
  ({ type, data, position: ++position, transactionId: "1", tags: [], correlationId: null }) as unknown as StoredEvent;

const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect);

describe("defineView", () => {
  test("the subscription selects the event types of the handlers, and keeps the overrides", () => {
    const sub = view.subscription({ batchSize: 50 });
    expect(sub.viewName).toBe("accounts-view");
    expect([...sub.eventTypes].sort()).toEqual(["Closed", "Deposited", "Opened"]);
    expect(sub.batchSize).toBe(50);
    expect(view.tables).toEqual([accounts]);
  });

  test("what the view reads besides its event types is declared with it, and the subscription carries it", () => {
    const scoped = defineView("scoped", { tables: [accounts], anyOfTags: new Set(["account_id", "to_id"]) }).on(Opened, () => undefined);
    const sub = scoped.subscription();
    expect([...sub.anyOfTags].sort()).toEqual(["account_id", "to_id"]);
    expect([...sub.eventTypes]).toEqual(["Opened"]);
    expect(scoped.tables).toEqual([accounts]);
  });

  test("an event with no handler writes nothing", async () => {
    expect(await run(view.opsOf(stored("Other", {})))).toEqual([]);
  });

  test("a handler may return nothing, one operation or a list", async () => {
    const none = defineView("none", { tables: [accounts] }).on(Closed, () => undefined).on(Opened, () => []);
    expect(await run(none.opsOf(stored("Closed", { id: "a" })))).toEqual([]);
    expect(await run(none.opsOf(stored("Opened", { id: "a", balance: 1 })))).toEqual([]);
    expect(await run(view.opsOf(stored("Closed", { id: "a" })))).toHaveLength(1);
  });

  test("a payload the definition cannot read fails with EventDecodingError, never skipped", async () => {
    const error = await Effect.runPromise(Effect.flip(view.opsOf(stored("Deposited", { id: "a", amount: "ten", at: "x" }))));
    expect(error).toBeInstanceOf(EventDecodingError);
    expect(error.type).toBe("Deposited");
  });

  test("two handlers for one event type are refused", () => {
    expect(() => view.on(Opened, () => undefined)).toThrow("already declared");
  });

  test("the context carries the position and the tags", async () => {
    let seen: { position: bigint; tag: string | undefined } | undefined;
    const v = defineView("ctx", { tables: [] }).on(Closed, (_d, ctx) => {
      seen = { position: ctx.position, tag: ctx.tag("id") };
      return undefined;
    });
    const event = { ...stored("Closed", { id: "a" }), tags: [{ key: "id", value: "a" }] } as unknown as StoredEvent;
    await run(v.opsOf(event));
    expect(seen).toEqual({ position: event.position, tag: "a" });
  });

  test("the operations are checked against the table's types", () => {
    // @ts-expect-error a column the table does not have
    accounts.update({ id: "a" }, { set: { nope: 1 } });
    // @ts-expect-error add is for numeric columns, and last_at is a timestamp
    accounts.update({ id: "a" }, { add: { last_at: 1 } });
    // @ts-expect-error the value must be a number
    accounts.update({ id: "a" }, { add: { balance: "1" } });
    // @ts-expect-error the key is missing
    accounts.remove({});
    // @ts-expect-error a column without a default is required on insert
    viewTable("t", { key: { id: text() }, columns: { name: text() } }).insert({ id: "a" }, { onConflict: "ignore" });
  });
});

describe("applyInMemory", () => {
  test("replays a history: replace, upsert (new row, then existing), max, remove", async () => {
    const db = await run(
      applyInMemory(view, [
        stored("Deposited", { id: "a", amount: 5, at: "2026-01-02T00:00:00Z" }),
        stored("Opened", { id: "a", balance: 100 }),
        stored("Deposited", { id: "a", amount: 7, at: "2026-01-01T00:00:00Z" }),
        stored("Opened", { id: "b", balance: 1 }),
        stored("Closed", { id: "b" })
      ])
    );
    // The first deposit made the row (5, one deposit); "Opened" replaced the balance (100) and left the other columns; the second deposit added 7 and kept the later instant.
    expect(rowsOf(db, accounts)).toEqual([{ id: "a", balance: 107, deposits: 2, last_at: Date.parse("2026-01-02T00:00:00Z") }]);
  });

  test("an update with no row changes nothing, an insert with ignore keeps the row", async () => {
    const v = defineView("v", { tables: [accounts] })
      .on(Deposited, (d) => accounts.update({ id: d.id }, { add: { balance: d.amount } }))
      .on(Opened, (d) => accounts.insert({ id: d.id, balance: d.balance }, { onConflict: "ignore" }));
    const db = await run(applyInMemory(v, [stored("Deposited", { id: "a", amount: 5, at: "2026-01-01T00:00:00Z" }), stored("Opened", { id: "a", balance: 1 }), stored("Opened", { id: "a", balance: 9 })]));
    expect(rowsOf(db, accounts)).toEqual([{ id: "a", balance: 1, deposits: 0, last_at: null }]);
  });
});
