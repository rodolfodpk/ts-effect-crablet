// The SPIKE of ADR-0017 (event evolution by compatibility), recorded as tests: how to write "an optional key with a default" in the pinned Effect Schema 4.0.0, how it
// behaves through `defineEvent` (decode, tags, types, personal data), and what a decoding failure looks like (the shape a typed EventDecodingError would carry).
import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import * as Schema from "effect/Schema";
import * as SchemaIssue from "effect/SchemaIssue";
import { defineEvent } from "../src/Event.ts";
import { personal, personalPaths } from "../src/Personal.ts";

// the event as first written, and as it is now: a `fee` was added, with a default for every event written before it
const V1 = Schema.Struct({ id: Schema.String, amount: Schema.Number });
const V2 = Schema.Struct({
  id: Schema.String,
  amount: Schema.Number,
  fee: Schema.Number.pipe(Schema.withDecodingDefaultKey(Effect.succeed(0)))
});
const Deposit = defineEvent("Deposit", { schema: V2, tags: (d) => ({ deposit_id: d.id }) });

describe("a default for a field added later (Schema.withDecodingDefaultKey)", () => {
  test("a payload written before the field existed decodes with the default; one that has it keeps its value", () => {
    expect(Deposit.decode({ id: "a", amount: 5 })).toEqual({ id: "a", amount: 5, fee: 0 });
    expect(Deposit.decode({ id: "a", amount: 5, fee: 2 })).toEqual({ id: "a", amount: 5, fee: 2 });
  });

  test("the decoded type has the field REQUIRED: code that reads events never handles a missing fee, and new events must carry it", () => {
    const decoded = Deposit.decode({ id: "a", amount: 5 });
    const fee: number = decoded.fee; // not number | undefined
    expect(fee).toBe(0);
    // @ts-expect-error a new event must be built with its fee: the default is for OLD stored payloads only
    Deposit({ id: "a", amount: 5 });
    expect(Deposit({ id: "a", amount: 5, fee: 1 }).type).toBe("Deposit");
  });

  test("a payload from a NEWER writer, with fields this reader does not know, decodes (they are ignored): the tolerant reader both ways", () => {
    expect(Deposit.decode({ id: "a", amount: 5, fee: 2, addedLater: { anything: true } })).toEqual({ id: "a", amount: 5, fee: 2 });
  });

  test("the default is for an ABSENT key only: a present key of the wrong type, or null, is still an error", () => {
    expect(() => Deposit.decode({ id: "a", amount: 5, fee: "2" })).toThrow();
    expect(() => Deposit.decode({ id: "a", amount: 5, fee: null })).toThrow();
  });

  test("the old shape is still decoded by the OLD definition: the two coexist in one log", () => {
    const old = defineEvent("Deposit", { schema: V1, tags: (d) => ({ deposit_id: d.id }) });
    expect(old.decode({ id: "a", amount: 5, fee: 2 })).toEqual({ id: "a", amount: 5 });
  });

  test("what is stored is the decoded value as written (the event's data), so a new event carries its fee and an old one is left as it was", () => {
    expect(Deposit({ id: "a", amount: 5, fee: 0 }).eventData).toEqual({ id: "a", amount: 5, fee: 0 });
  });

  test("encoding can leave a defaulted key out (`encodingStrategy: omit`) or keep it (default)", () => {
    const Omit = Schema.Struct({ id: Schema.String, fee: Schema.Number.pipe(Schema.withDecodingDefaultKey(Effect.succeed(0), { encodingStrategy: "omit" })) });
    const encodeOmit = Schema.encodeSync(Omit as never) as unknown as (x: unknown) => unknown;
    expect(encodeOmit({ id: "a", fee: 0 })).toEqual({ id: "a" });
    const encodeKeep = Schema.encodeSync(V2 as never) as unknown as (x: unknown) => unknown;
    expect(encodeKeep({ id: "a", amount: 1, fee: 0 })).toEqual({ id: "a", amount: 1, fee: 0 });
  });
});

describe("a field with NO sensible default is optional, not defaulted", () => {
  const WithNote = Schema.Struct({ id: Schema.String, note: Schema.optionalKey(Schema.String) });
  test("an absent key stays absent (the type is `note?: string`), so no value is invented", () => {
    const decode = Schema.decodeUnknownSync(WithNote as never) as (x: unknown) => { id: string; note?: string };
    expect(decode({ id: "a" })).toEqual({ id: "a" });
    expect("note" in decode({ id: "a" })).toBe(false);
    expect(decode({ id: "a", note: "x" }).note).toBe("x");
  });

  test("personal(...) is still found on an optional field: a default must not invent personal data (ADR-0017), so these are the ones to leave optional", () => {
    const S = Schema.Struct({ id: Schema.String, email: Schema.optionalKey(personal(Schema.String)) });
    expect(personalPaths(S as never)).toEqual(["email"]);
  });

  test("personal(...) on a field that also has a decoding default is FOUND too (so redaction and the audit still see it)", () => {
    const S = Schema.Struct({ id: Schema.String, email: personal(Schema.String).pipe(Schema.withDecodingDefaultKey(Effect.succeed(""))) });
    expect(personalPaths(S as never)).toEqual(["email"]);
  });
});

describe("a decoding failure: what a typed EventDecodingError can carry", () => {
  const failureOf = (payload: unknown) => {
    try {
      Deposit.decode(payload);
      return null;
    } catch (error) {
      return error as { _tag: string; issue: SchemaIssue.Issue; message: string };
    }
  };
  const issuesOf = (error: { issue: SchemaIssue.Issue }) => SchemaIssue.makeFormatterStandardSchemaV1()(error.issue).issues;

  test("the thrown value is a SchemaError with the issue tree, and the standard formatter turns it into a flat list of { path, message }; by default only the FIRST problem is reported", () => {
    const error = failureOf({ id: 1, amount: "x" })!;
    expect(error._tag).toBe("SchemaError");
    expect(issuesOf(error).map((i) => ({ path: i.path, message: i.message }))).toEqual([{ path: ["id"], message: "Expected string" }]);
  });

  test("with `{ errors: \"all\" }` every problem is reported: that is what EventDecodingError should ask for", () => {
    const decodeAll = Schema.decodeUnknownSync(V2 as never) as unknown as (x: unknown, options?: { readonly errors?: "first" | "all" }) => unknown;
    try {
      decodeAll({ id: 1, amount: "x" }, { errors: "all" });
      throw new Error("should have failed");
    } catch (error) {
      expect(issuesOf(error as never).map((i) => ({ path: i.path, message: i.message }))).toEqual([
        { path: ["id"], message: "Expected string" },
        { path: ["amount"], message: "Expected number" }
      ]);
    }
  });

  test("a missing required key is reported with its path", () => {
    expect(issuesOf(failureOf({ id: "a" })!).map((i) => ({ path: i.path, message: i.message }))).toEqual([{ path: ["amount"], message: "Missing key" }]);
  });

  test("the default messages do NOT echo the offending value, so issues can be logged for events that carry personal data", () => {
    const S = Schema.Struct({ email: personal(Schema.String.check(Schema.isMinLength(8))), age: Schema.Number, kind: Schema.Literals(["a", "b"]) });
    const decode = Schema.decodeUnknownSync(S as never);
    for (const payload of [{ email: "a@b.c", age: 1, kind: "a" }, { email: "long-enough@x.com", age: "personal-42", kind: "a" }, { email: "long-enough@x.com", age: 1, kind: "secret-value" }]) {
      try {
        decode(payload);
        throw new Error("should have failed");
      } catch (error) {
        const text = JSON.stringify(issuesOf(error as never));
        for (const secret of ["a@b.c", "personal-42", "secret-value", "long-enough"]) expect(text.includes(secret)).toBe(false);
      }
    }
  });
});

// DCB rule B (ADR-0017): tags are stored when the event is written and are how a boundary finds it. A tag computed from a field that was DEFAULTED does not exist on
// the events written before the field did. A fixture check (the payload an event type was once written with, and the tags it was stored with) finds that.
describe("tags and old events: the fixture check (prototype of ADR-0017 step 3)", () => {
  // what was stored when the event was written under the OLD definition
  const stored = { type: "Deposit", payload: { id: "a", amount: 5 }, tags: [{ key: "deposit_id", value: "a" }] };
  const problems = (def: ReturnType<typeof defineEvent<"Deposit", any, any>>, fixture: typeof stored): ReadonlyArray<string> => {
    let decoded: unknown;
    try {
      decoded = def.decode(fixture.payload);
    } catch (error) {
      return [`the current definition cannot decode a payload written before: ${String(error).split("\n")[0]}`];
    }
    const now = (def as unknown as (d: unknown) => { tags: ReadonlyArray<{ key: string; value: string }> })(decoded).tags;
    const key = (t: { key: string; value: string }) => `${t.key}=${t.value}`;
    const missing = fixture.tags.filter((t) => !now.some((n) => key(n) === key(t))).map(key);
    const invented = now.filter((n) => !fixture.tags.some((t) => key(t) === key(n))).map(key);
    return [...missing.map((t) => `the stored tag ${t} is no longer derived`), ...invented.map((t) => `the definition now derives ${t}, which this stored event does not have (a boundary on it would miss the event)`)];
  };

  test("a compatible change (a defaulted field that no tag uses) passes", () => {
    expect(problems(Deposit as never, stored)).toEqual([]);
  });

  test("a tag computed from the defaulted field is caught: the old event does not carry it", () => {
    const Tagged = defineEvent("Deposit", { schema: V2, tags: (d) => ({ deposit_id: d.id, fee_class: d.fee > 0 ? "paid" : "free" }) });
    expect(problems(Tagged as never, stored)).toEqual(["the definition now derives fee_class=free, which this stored event does not have (a boundary on it would miss the event)"]);
  });

  test("a rename or a new required field is caught as an undecodable old payload", () => {
    const Renamed = defineEvent("Deposit", { schema: Schema.Struct({ depositId: Schema.String, amount: Schema.Number }), tags: (d) => ({ deposit_id: d.depositId }) });
    expect(problems(Renamed as never, stored)[0]).toContain("cannot decode a payload written before");
  });
});
