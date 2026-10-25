// An event's payload is stored encoded by its schema and read back decoded (Event.ts): a field that transforms, such as an `Instant`, works everywhere
// an event is read, including the fold of a command's own events before they are stored (byModel()).
import { describe, expect, test } from "bun:test";
import { DateTime } from "effect";
import * as Schema from "effect/Schema";
import { byModel, defineCommand, defineEvent, defineModel, emit, Instant, noop } from "../src/Domain.ts";
import { EventDecodingFailure } from "@crablet/eventstore/EventDecoding";
import { given } from "../src/testing/Scenario.ts";

const Opened = defineEvent("EncOpened", {
  schema: Schema.Struct({ accountId: Schema.String, openedAt: Instant }),
  tags: (d) => ({ account_id: d.accountId })
});

const Account = defineModel({ by: "account_id", initial: () => ({ openedAt: null as DateTime.Utc | null }) }).on(Opened, (_s, d) => ({ openedAt: d.openedAt }));

const Open = defineCommand({
  name: "enc_open",
  input: Schema.Struct({ accountId: Schema.String }),
  model: (c) => Account.of({ id: c.accountId }),
  idempotentBy: byModel(),
  decide: (s, c, { now }) => (s.openedAt !== null ? noop("ALREADY_OPEN") : emit(Opened({ accountId: c.accountId, openedAt: now })))
});

const at = new Date("2026-11-02T09:00:00.000Z");

describe("an event's payload is stored encoded and read decoded", () => {
  test("an Instant is built with a DateTime, stored as ISO text, and read back as a DateTime", () => {
    const built = Opened({ accountId: "a1", openedAt: DateTime.fromDateUnsafe(at) });
    expect(built.eventData).toEqual({ accountId: "a1", openedAt: "2026-11-02T09:00:00.000Z" });
    const read = Opened.decode(JSON.parse(JSON.stringify(built.eventData)));
    expect(DateTime.isDateTime(read.openedAt)).toBe(true);
    expect(DateTime.toEpochMillis(read.openedAt)).toBe(at.getTime());
  });

  test("a command whose model folds a transforming field passes the byModel() check, and its repeat is recognised", async () => {
    const s = given().at(at);
    const first = await s.when(Open, { accountId: "a1" });
    expect(first.outcome).toBe("created");
    expect(first.events.map((e) => e.data)).toEqual([{ accountId: "a1", openedAt: "2026-11-02T09:00:00.000Z" }]);
    expect((await s.when(Open, { accountId: "a1" })).reason).toBe("ALREADY_OPEN");
  });

  test("an Instant is described to OpenAPI as a string with format date-time, so generated clients get a date type", () => {
    const doc = Schema.toJsonSchemaDocument(Schema.Struct({ at: Instant }));
    expect(doc.schema).toMatchObject({ properties: { at: { type: "string", format: "date-time" } } });
  });

  test("text that is not an instant fails to decode, loudly", () => {
    expect(() => Opened.decode({ accountId: "a1", openedAt: "not a date" })).toThrow(EventDecodingFailure);
  });

  test("a payload that does not fit its schema fails where the event is built, naming the path and not the value", () => {
    const Counted = defineEvent("EncCounted", { schema: Schema.Struct({ id: Schema.String, n: Schema.Int }), tags: (d) => ({ id: d.id }) });
    expect(() => Counted({ id: "x", n: 1.5 })).toThrow(/event "EncCounted" cannot be built: n: /);
    expect(() => Counted({ id: "x", n: 1.5 })).not.toThrow(/1\.5/);
  });
});
