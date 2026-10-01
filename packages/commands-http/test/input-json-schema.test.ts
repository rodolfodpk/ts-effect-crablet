import { describe, expect, test } from "bun:test";
import * as Schema from "effect/Schema";
import { defineCommand, noop } from "@crablet/commands/Command";
import { inputJsonSchema, inputJsonSchemaProblems } from "../src/InputJsonSchema.ts";

const commandWith = <S extends Schema.Constraint>(input: S) => defineCommand({ name: "probe", input, decide: () => noop() });

describe("a command's input as JSON Schema", () => {
  test("keeps the checks of Finite and Int, a literal's values, and required fields", () => {
    const doc = JSON.stringify(
      inputJsonSchema(
        commandWith(
          Schema.Struct({
            amount: Schema.Finite.check(Schema.isGreaterThan(0)),
            count: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
            kind: Schema.Literals(["a", "b"]),
            note: Schema.optional(Schema.String)
          })
        )
      )
    );
    expect(doc).toContain('"exclusiveMinimum":0');
    expect(doc).toContain('"minimum":1');
    expect(doc).toContain('"enum":["a","b"]');
    expect(doc).toContain('"required":["amount","count","kind"]');
  });

  test("the command exposes the very schema it validates with", () => {
    const input = Schema.Struct({ id: Schema.String });
    expect(commandWith(input).input).toBe(input);
  });
});

describe("inputJsonSchemaProblems", () => {
  test("a Schema.Number field is reported (its checks would not reach the description)", () => {
    const problems = inputJsonSchemaProblems(commandWith(Schema.Struct({ amount: Schema.Number.check(Schema.isGreaterThan(0)) })));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("Schema.Finite");
  });

  test("Finite, Int, strings and nested structures are fine", () => {
    const input = Schema.Struct({
      amount: Schema.Finite,
      items: Schema.Array(Schema.Struct({ id: Schema.String, qty: Schema.Int }))
    });
    expect(inputJsonSchemaProblems(commandWith(input))).toEqual([]);
  });
});
