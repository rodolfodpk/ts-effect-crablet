import { describe, expect, test } from "bun:test";
import * as Schema from "effect/Schema";
import { defineCommand, fail, noop } from "@crablet/commands/Command";
import { DomainError } from "@crablet/commands/Errors";
import { exposedCommandOf, type ExposedCommand } from "../src/ExposedCommand.ts";
import { domainProblemOf, problemSchemaOf } from "../src/ProblemDetail.ts";

class NoSuchThing extends DomainError("NoSuchThing", { fields: { id: Schema.String }, kind: "not_found" }) {}
class NotYours extends DomainError("NotYours", { fields: {}, kind: "forbidden" }) {}

const OpenWallet = defineCommand({
  name: "open_wallet",
  input: Schema.Struct({ walletId: Schema.String }),
  decide: () => noop()
});
const Find = defineCommand({
  name: "find",
  input: Schema.Struct({ id: Schema.String }),
  errors: [NoSuchThing, NotYours],
  decide: (_, c) => (c.id === "x" ? fail(new NoSuchThing({ id: c.id })) : fail(new NotYours()))
});

describe("exposedCommandOf", () => {
  test("wraps a defined command; the command's declared errors are what the API documents", () => {
    const entry = exposedCommandOf(Find);
    expect(entry.command).toBe(Find);
    expect(entry.command.errors).toEqual([NoSuchThing, NotYours]);
    expect(exposedCommandOf(OpenWallet).command.errors).toEqual([]);
  });

  test("a map of entries supports lookup by command name", () => {
    const openWallet = exposedCommandOf(OpenWallet);
    // The registry is type-erased at this boundary - see ExposedCommand.ts.
    const commands: Readonly<Record<string, ExposedCommand<any, any>>> = { open_wallet: openWallet };

    expect(commands["open_wallet"]).toBe(openWallet);
    expect(commands["unknown_command"]).toBeUndefined();
  });

  test("a command failing with something that is not a domain error cannot be exposed at all", () => {
    const Bad = defineCommand({ name: "bad", input: Schema.Struct({ id: Schema.String }), decide: () => fail("just a string" as const) });
    // @ts-expect-error - "just a string" is neither a declared domain error nor a framework error
    exposedCommandOf(Bad);
  });
});

describe("what a declared error looks like on the wire", () => {
  test("domainProblemOf: status and title come from the kind; the error's declared fields ride along", () => {
    expect(domainProblemOf("not_found", new NoSuchThing({ id: "t1" }))).toEqual({
      type: "urn:crablet:problem:command-api:not-found",
      title: "Not Found",
      status: 404,
      detail: "NoSuchThing",
      errorType: "NoSuchThing",
      fields: { id: "t1" }
    });
  });

  test("problemSchemaOf: one schema per class, the same instance every time, accepting exactly that problem", () => {
    const schema = problemSchemaOf(NoSuchThing);
    expect(problemSchemaOf(NoSuchThing)).toBe(schema);
    expect(problemSchemaOf(NotYours)).not.toBe(schema);

    const decode = Schema.decodeUnknownExit(schema as never);
    expect(decode(domainProblemOf("not_found", new NoSuchThing({ id: "t1" })))._tag).toBe("Success");
    // another error's problem, or the right problem with the wrong fields, is not this schema
    expect(decode(domainProblemOf("forbidden", new NotYours()))._tag).toBe("Failure");
    expect(decode({ ...(domainProblemOf("not_found", new NoSuchThing({ id: "t1" })) as object), fields: { id: 5 } })._tag).toBe("Failure");
  });
});
