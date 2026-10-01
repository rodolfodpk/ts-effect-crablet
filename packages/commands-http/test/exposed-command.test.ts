import { describe, expect, test } from "bun:test";
import * as Schema from "effect/Schema";
import { defineCommand, noop } from "@crablet/commands/Command";
import { DomainError } from "@crablet/commands/Errors";
import { fail } from "@crablet/commands/Command";
import { exposedCommandOf, type ExposedCommand } from "../src/ExposedCommand.ts";
import { domainProblemOf } from "../src/ProblemDetail.ts";

const OpenWallet = defineCommand({
  name: "open_wallet",
  input: Schema.Struct({ walletId: Schema.String }),
  decide: () => noop()
});

describe("exposedCommandOf", () => {
  test("wraps a defined command, with no error hook by default", () => {
    const entry = exposedCommandOf(OpenWallet);
    expect(entry.command).toBe(OpenWallet);
    expect(entry.mapError).toBeUndefined();
  });

  test("carries an optional hook that presents the command's own errors", () => {
    const hook = (_error: never) => ({ type: "problem" });
    expect(exposedCommandOf(OpenWallet, hook).mapError).toBe(hook);
  });

  test("a map of entries supports lookup by commandType key", () => {
    const openWallet = exposedCommandOf(OpenWallet);
    // The registry is type-erased at this boundary - see ExposedCommand.ts.
    const commands: Readonly<Record<string, ExposedCommand<any, any>>> = { open_wallet: openWallet };

    expect(commands["open_wallet"]).toBe(openWallet);
    expect(commands["unknown_command"]).toBeUndefined();
  });
});

class NoSuchThing extends DomainError("NoSuchThing", { fields: { id: Schema.String }, kind: "not_found" }) {}

describe("what can be exposed (checked by the type checker)", () => {
  test("a command failing with declared domain errors needs no hook", () => {
    const Find = defineCommand({ name: "find", input: Schema.Struct({ id: Schema.String }), decide: (_, c) => fail(new NoSuchThing({ id: c.id })) });
    expect(exposedCommandOf(Find).command).toBe(Find);
  });

  test("a command failing with an error the API cannot present is a compile error unless a hook presents it", () => {
    const Bad = defineCommand({ name: "bad", input: Schema.Struct({ id: Schema.String }), decide: () => fail("just a string" as const) });
    // @ts-expect-error - "just a string" is neither a declared domain error nor a framework error
    exposedCommandOf(Bad);
    // with a hook, anything goes
    expect(exposedCommandOf(Bad, (e) => ({ type: "urn:x", e })).mapError).toBeDefined();
  });
});

describe("domainProblemOf", () => {
  test("presents a declared domain error by its kind, with tag and fields", () => {
    const problem = domainProblemOf("not_found", new NoSuchThing({ id: "a1" })) as Record<string, unknown>;
    expect(problem).toMatchObject({ status: 404, title: "Not Found", errorType: "NoSuchThing", fields: { id: "a1" }, detail: "NoSuchThing" });
  });
});

class NotYours extends DomainError("NotYours", { fields: {}, kind: "forbidden" }) {}
class Other extends DomainError("Other", { fields: {}, kind: "invalid" }) {}

describe("declaring a command's domain errors", () => {
  const Find = defineCommand({
    name: "find",
    input: Schema.Struct({ id: Schema.String }),
    decide: (_, c) => (c.id === "x" ? fail(new NoSuchThing({ id: c.id })) : fail(new NotYours()))
  });

  test("the declared classes are carried on the entry, with their kind and fields", () => {
    const entry = exposedCommandOf(Find, { errors: [NoSuchThing, NotYours] });
    expect(entry.errors).toEqual([NoSuchThing, NotYours]);
    expect(entry.errors.map((e) => e.kind)).toEqual(["not_found", "forbidden"]);
    expect(Object.keys(entry.errors[0]!.fields)).toEqual(["id"]);
  });

  test("an entry without declarations has none, and the hook form still works", () => {
    expect(exposedCommandOf(Find).errors).toEqual([]);
    const hook = (_e: unknown) => ({ type: "p" });
    expect(exposedCommandOf(Find, hook).errors).toEqual([]);
  });

  test("leaving out a class the command can fail with is a compile error naming it; extra classes are fine", () => {
    // @ts-expect-error - NotYours is not declared (the message says: missingErrorClasses: NotYours)
    exposedCommandOf(Find, { errors: [NoSuchThing] });
    // @ts-expect-error - nothing declared although the command can fail with domain errors
    exposedCommandOf(Find, { errors: [] });
    expect(exposedCommandOf(Find, { errors: [NoSuchThing, NotYours, Other] }).errors).toHaveLength(3);

    const NoDomainErrors = defineCommand({ name: "plain", input: Schema.Struct({ id: Schema.String }), decide: () => noop() });
    expect(exposedCommandOf(NoDomainErrors, { errors: [] }).errors).toEqual([]);
  });
});
