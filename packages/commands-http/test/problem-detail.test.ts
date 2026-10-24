// What a declared domain error looks like on the wire: its status and title from the kind, its own fields, and one response schema per error class.
import { describe, expect, test } from "bun:test";
import * as Schema from "effect/Schema";
import { DateTime } from "effect";
import { DomainError } from "@crablet/commands/Errors";
import { Instant } from "@crablet/commands/Domain";
import { domainProblemOf, problemSchemaOf } from "../src/ProblemDetail.ts";

class NoSuchThing extends DomainError("NoSuchThing", { fields: { id: Schema.String }, kind: "not_found" }) {}
class NotYours extends DomainError("NotYours", { fields: {}, kind: "forbidden" }) {}
class TooLate extends DomainError("TooLate", { fields: { closedAt: Instant }, kind: "conflict" }) {}

describe("what a declared error looks like on the wire", () => {
  test("domainProblemOf: a field that transforms is encoded by its schema (an Instant goes out as ISO text)", () => {
    const problem = domainProblemOf("conflict", new TooLate({ closedAt: DateTime.makeUnsafe("2026-11-05T09:00:00Z") })) as { fields: unknown };
    expect(problem.fields).toEqual({ closedAt: "2026-11-05T09:00:00.000Z" });
  });

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
