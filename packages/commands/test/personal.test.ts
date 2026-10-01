import { describe, expect, test } from "bun:test";
import * as Schema from "effect/Schema";
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/http-api";
import { REDACTED, hasPersonalData, personal, personalPaths, redact } from "../src/Personal.ts";
import { defineEvent } from "../src/Event.ts";

const Address = Schema.Struct({ street: personal(Schema.String), city: Schema.String });
const Person = Schema.Struct({
  id: Schema.String,
  email: personal(Schema.String.check(Schema.isMinLength(3))), // personal AFTER a check
  nick: Schema.String.check(Schema.isMinLength(2)).pipe(personal), // check, then personal
  early: personal(Schema.String).check(Schema.isMinLength(2)), // personal BEFORE a check
  phone: Schema.optionalKey(personal(Schema.String)),
  nested: Schema.Struct({ taxId: personal(Schema.String), ok: Schema.Int }),
  addresses: Schema.Array(Address),
  maybe: Schema.NullOr(personal(Schema.String)),
  notes: Schema.Record(Schema.String, personal(Schema.String)),
  amount: Schema.Finite
});

describe("personal: marking", () => {
  test("is found whatever order the checks were written in, in every composition", () => {
    expect([...personalPaths(Person)].sort()).toEqual(
      ["addresses.[].street", "early", "email", "maybe", "nested.taxId", "nick", "notes.*", "phone"].sort()
    );
    expect(hasPersonalData(Person)).toBe(true);
    expect(hasPersonalData(Schema.Struct({ a: Schema.String, b: Schema.Int }))).toBe(false);
  });

  test("survives spreading fields into another struct", () => {
    const Wider = Schema.Struct({ ...Person.fields, extra: personal(Schema.String) });
    expect(personalPaths(Wider)).toContain("extra");
    expect(personalPaths(Wider)).toContain("nested.taxId");
  });

  test("a mark on a whole value is a path of its own", () => {
    expect(personalPaths(Schema.Struct({ contact: personal(Schema.Struct({ a: Schema.String })) }))).toEqual(["contact"]);
    expect(personalPaths(personal(Schema.String))).toEqual(["(root)"]);
  });

  test("marking changes nothing about decoding", () => {
    const decode = Schema.decodeUnknownExit(Schema.Struct({ email: personal(Schema.String.check(Schema.isMinLength(3))), n: personal(Schema.Finite) }) as never);
    expect(decode({ email: "abc", n: 1 })._tag).toBe("Success");
    expect(decode({ email: "ab", n: 1 })._tag).toBe("Failure"); // the other checks still apply
    expect(decode({ email: "abc", n: "x" })._tag).toBe("Failure");
  });

  test("the flag reaches the generated JSON Schema and OpenAPI description", () => {
    const input = Schema.Struct({ email: personal(Schema.String), plain: Schema.String });
    const doc = JSON.stringify((Schema as any).toJsonSchemaDocument(input));
    expect(doc).toContain('"x-personal":true');

    const group = HttpApiGroup.make("g").add(HttpApiEndpoint.post("p", "/p", { payload: input, success: Schema.Struct({ ok: Schema.Boolean }) }));
    const spec = OpenApi.fromApi(HttpApi.make("a").add(group)) as any;
    const props = spec.paths["/p"].post.requestBody.content["application/json"].schema.properties;
    expect(JSON.stringify(props.email)).toContain('"x-personal":true');
    expect(JSON.stringify(props.plain)).not.toContain("x-personal");
  });

  test("an event definition exposes its schema", () => {
    const schema = Schema.Struct({ userId: Schema.String, email: personal(Schema.String) });
    const Registered = defineEvent("Registered", { schema, tags: (d) => ({ user_id: d.userId }) });
    expect(Registered.schema).toBe(schema);
    expect(personalPaths(Registered.schema as never)).toEqual(["email"]);
  });
});

describe("redact", () => {
  const value = {
    id: "u1",
    email: "ann@example.com",
    nick: "annie",
    early: "xx",
    phone: "+55 11 99999-0000",
    nested: { taxId: "123.456.789-00", ok: 1 },
    addresses: [{ street: "Rua A", city: "SP" }, { street: "Rua B", city: "RJ" }],
    maybe: null as string | null,
    notes: { a: "secret", b: "also" },
    amount: 10
  };

  test("replaces every marked value and keeps the rest", () => {
    expect(redact(Person, value)).toEqual({
      id: "u1",
      email: REDACTED,
      nick: REDACTED,
      early: REDACTED,
      phone: REDACTED,
      nested: { taxId: REDACTED, ok: 1 },
      addresses: [{ street: REDACTED, city: "SP" }, { street: REDACTED, city: "RJ" }],
      maybe: null,
      notes: { a: REDACTED, b: REDACTED },
      amount: 10
    });
  });

  test("never mutates its input; nothing to redact returns the SAME reference", () => {
    const copy = structuredClone(value);
    redact(Person, value);
    expect(value).toEqual(copy);
    const plain = { id: "x", city: "SP" };
    expect(redact(Schema.Struct({ id: Schema.String, city: Schema.String }), plain)).toBe(plain);
  });

  test("a missing optional key stays missing, null stays null, a present NullOr value is redacted", () => {
    const out = redact(Person, { ...value, phone: undefined, maybe: "secret" }) as Record<string, unknown>;
    expect(out["phone"]).toBeUndefined();
    expect(out["maybe"]).toBe(REDACTED);
    const withoutPhone = { ...value } as Record<string, unknown>;
    delete withoutPhone["phone"];
    expect("phone" in (redact(Person, withoutPhone) as object)).toBe(false);
  });

  test("a marked object or array is replaced as a whole; a custom replacement is honoured", () => {
    const S = Schema.Struct({ contact: personal(Schema.Struct({ a: Schema.String })), tags: personal(Schema.Array(Schema.String)), ok: Schema.String });
    expect(redact(S, { contact: { a: "x" }, tags: ["p", "q"], ok: "fine" }, "***")).toEqual({ contact: "***", tags: "***", ok: "fine" });
  });

  test("keys the schema does not know are left alone (dropping them is the caller's job)", () => {
    const S = Schema.Struct({ email: personal(Schema.String) });
    expect(redact(S, { email: "a@b.c", legacyPhone: "123" })).toEqual({ email: REDACTED, legacyPhone: "123" });
  });

  test("unions: the member that applies redacts; a union of shapes tries each in turn", () => {
    const U = Schema.Union([Schema.Struct({ kind: Schema.Literal("a"), name: personal(Schema.String) }), Schema.Struct({ kind: Schema.Literal("b"), id: Schema.String })]);
    expect(redact(U, { kind: "a", name: "Ann" })).toEqual({ kind: "a", name: REDACTED });
    expect(redact(U, { kind: "b", id: "7" })).toEqual({ kind: "b", id: "7" });
  });

  test("a value that does not fit the schema's shape is returned unchanged", () => {
    expect(redact(Person, "not an object")).toBe("not an object");
    expect(redact(Schema.Struct({ xs: Schema.Array(personal(Schema.String)) }), { xs: "nope" })).toEqual({ xs: "nope" });
  });
});
