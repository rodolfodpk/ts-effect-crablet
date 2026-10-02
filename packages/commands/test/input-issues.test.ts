// What a failed input says, as data: InvalidInput.issues (one { path, message } per failed check). A transport presents
// them to clients (commands-http puts them in the 400 problem); here we pin the shape and what must NOT be in it.
import { describe, expect, test } from "bun:test";
import { Cause, Effect, Exit, Schema } from "effect";
import { defineCommand, emit } from "../src/Command.ts";
import { InvalidInput } from "../src/Errors.ts";
import { defineEvent } from "../src/Event.ts";
import { personal } from "../src/Personal.ts";

const Done = defineEvent("InputIssuesDone", { schema: Schema.Struct({ id: Schema.String }), tags: (d) => ({ id: d.id }) });
const Register = defineCommand({
  name: "register",
  input: Schema.Struct({
    id: Schema.String,
    capacity: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
    email: personal(Schema.String),
    user: Schema.Struct({ tags: Schema.Array(Schema.String) })
  }),
  decide: (_state, c) => emit(Done({ id: c.id }))
});

const invalid = async (raw: unknown): Promise<InvalidInput> => {
  const exit = await Effect.runPromiseExit(Register.decodeInput(raw));
  const error = Exit.isFailure(exit) ? exit.cause.reasons.find(Cause.isFailReason)?.error : undefined;
  if (!(error instanceof InvalidInput)) throw new Error("expected an InvalidInput");
  return error;
};
const good = { id: "r1", capacity: 3, email: "ann@example.org", user: { tags: ["a"] } };

describe("InvalidInput.issues", () => {
  test("names the failing field", async () => {
    expect((await invalid({ ...good, capacity: 0 })).issues).toEqual([
      { path: ["capacity"], message: "Expected a value greater than or equal to 1" }
    ]);
  });

  test("reports EVERY failed field at once, including nested ones and array indexes", async () => {
    const error = await invalid({ id: 5, capacity: 0, email: "ann@example.org", user: { tags: ["a", 1] } });
    expect(error.issues).toEqual([
      { path: ["id"], message: "Expected string" },
      { path: ["capacity"], message: "Expected a value greater than or equal to 1" },
      { path: ["user", "tags", 1], message: "Expected string" }
    ]);
  });

  test("a missing field is reported at its own path", async () => {
    const { email: _omitted, ...withoutEmail } = good;
    expect((await invalid(withoutEmail)).issues?.map((i) => i.path)).toEqual([["email"]]);
  });

  test("the received value is never in the issues, nor a personal one in the message the schema built", async () => {
    // the field marked personal gets a wrong-typed value; another field gets a recognisable string where a number is expected
    const error = await invalid({ ...good, email: 12345678, capacity: "SECRET-CAPACITY-VALUE" });
    const wire = JSON.stringify(error.issues);
    expect(wire).not.toContain("12345678");
    expect(wire).not.toContain("SECRET-CAPACITY-VALUE");
    expect(error.issues?.length).toBe(2);
  });

  test("input that is not even an object has one issue at the root", async () => {
    expect((await invalid("not an object")).issues).toEqual([{ path: [], message: "Expected object" }]);
  });

  test("valid input still decodes", async () => {
    expect(await Effect.runPromise(Register.decodeInput(good))).toEqual(good);
  });
});
