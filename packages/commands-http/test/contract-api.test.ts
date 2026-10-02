// The command API from contracts, at runtime and without a database: it describes exactly what the registry form describes, and the
// server's commands are checked against the contracts when they are registered.
import { describe, expect, test } from "bun:test";
import * as Schema from "effect/Schema";
import { OpenApi } from "effect/http-api";
import { defineCommand, emit } from "@crablet/commands/Command";
import { commandContract } from "@crablet/commands/Contract";
import { DomainError } from "@crablet/commands/Errors";
import { defineEvent } from "@crablet/commands/Event";
import { ContractMismatch, checkImplementations, makeCommandApi } from "../src/CommandApi.ts";
import { exposedCommandOf } from "../src/ExposedCommand.ts";

class Taken extends DomainError("Taken", { fields: { id: Schema.String }, kind: "conflict" }) {}
const Done = defineEvent("ContractApiDone", { schema: Schema.Struct({ id: Schema.String }), tags: (d) => ({ id: d.id }) });
const ClaimContract = commandContract({ name: "claim", input: Schema.Struct({ id: Schema.String }), errors: [Taken] });
const LogContract = commandContract({ name: "log", input: Schema.Struct({ note: Schema.String }) });
const contracts = [ClaimContract, LogContract];
const Claim = defineCommand({ ...ClaimContract, decide: (_s, c) => emit(Done(c)) });
const Log = defineCommand({ ...LogContract, decide: (_s, c) => emit(Done({ id: c.note })) });

describe("makeCommandApi from contracts", () => {
  test("describes exactly what the registry form describes", () => {
    const fromContracts = OpenApi.fromApi(makeCommandApi("/api/commands", contracts));
    const fromRegistry = OpenApi.fromApi(makeCommandApi("/api/commands", { claim: exposedCommandOf(Claim), log: exposedCommandOf(Log) }));
    expect(JSON.stringify(fromContracts)).toBe(JSON.stringify(fromRegistry));
    expect(Object.keys(fromContracts.paths).sort()).toEqual(["/api/commands", "/api/commands/claim", "/api/commands/log"]);
  });
});

describe("checkImplementations", () => {
  test("accepts commands built from their contracts", () => {
    expect(() => checkImplementations(contracts, { claim: Claim, log: Log })).not.toThrow();
  });

  test("names a contract with no command", () => {
    expect(() => checkImplementations(contracts, { claim: Claim })).toThrow(/no command for the contract "log"/);
  });

  test("names a command with no contract", () => {
    expect(() => checkImplementations(contracts, { claim: Claim, log: Log, extra: Log })).toThrow(/"extra" is implemented but has no contract/);
  });

  test("names a command registered under another contract's name", () => {
    expect(() => checkImplementations(contracts, { claim: Log, log: Log })).toThrow(/registered as "claim" is named "log"/);
  });

  test("a command that merely RESEMBLES its contract is refused: its input must be the contract's own", () => {
    const lookalike = defineCommand({ name: "log", input: Schema.Struct({ note: Schema.String }), decide: (_s, c) => emit(Done({ id: c.note })) });
    expect(() => checkImplementations(contracts, { claim: Claim, log: lookalike })).toThrow(/"log": the command's input is not the contract's/);
  });

  test("a command with a WIDER input (which the types cannot catch) is refused too", () => {
    const wider = defineCommand({ name: "log", input: Schema.Struct({ note: Schema.String, extra: Schema.String }), decide: (_s, c) => emit(Done({ id: c.note })) });
    expect(() => checkImplementations(contracts, { claim: Claim, log: wider })).toThrow(ContractMismatch);
  });

  test("lists every problem at once", () => {
    try {
      checkImplementations(contracts, { extra: Log });
      throw new Error("expected a ContractMismatch");
    } catch (error) {
      expect(error).toBeInstanceOf(ContractMismatch);
      expect((error as ContractMismatch).problems).toEqual([
        'no command for the contract "claim"',
        'no command for the contract "log"',
        '"extra" is implemented but has no contract'
      ]);
    }
  });
});
