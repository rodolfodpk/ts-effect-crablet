// commandContract at runtime: a plain { name, input, errors } and the very objects it was given (identity matters: the server checks that
// a command was built from its contract by comparing `input` and `errors` by reference).
import { describe, expect, test } from "bun:test";
import * as Schema from "effect/Schema";
import { defineCommand, emit } from "../src/Command.ts";
import { commandContract } from "../src/Contract.ts";
import { DomainError } from "../src/Errors.ts";
import { defineEvent } from "../src/Event.ts";

class Taken extends DomainError("Taken", { fields: { id: Schema.String }, kind: "conflict" }) {}
const Input = Schema.Struct({ id: Schema.String });
const Done = defineEvent("ContractDone", { schema: Schema.Struct({ id: Schema.String }), tags: (d) => ({ id: d.id }) });

describe("commandContract", () => {
  test("keeps the name, the input Schema and the errors as given", () => {
    const errors = [Taken] as const;
    const contract = commandContract({ name: "claim", input: Input, errors });
    expect(contract.name).toBe("claim");
    expect(contract.input).toBe(Input);
    expect(contract.errors).toBe(errors);
  });

  test("a contract with no errors declares an empty list", () => {
    expect(commandContract({ name: "log", input: Input }).errors).toEqual([]);
  });

  test("a command built by spreading it has the contract's own objects", () => {
    const contract = commandContract({ name: "claim", input: Input, errors: [Taken] });
    const command = defineCommand({ ...contract, decide: (_state, c) => emit(Done(c)) });
    expect(command.name).toBe("claim");
    expect(command.input).toBe(contract.input);
    expect(command.errors).toBe(contract.errors);
  });

  test("the same holds when there are no errors (the default empty list is the contract's list, not a new one)", () => {
    const contract = commandContract({ name: "log", input: Input });
    const command = defineCommand({ ...contract, decide: (_state, c) => emit(Done(c)) });
    expect(command.errors).toBe(contract.errors);
  });
});
