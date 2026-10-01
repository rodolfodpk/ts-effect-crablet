// What the generated API description says about the command routes (no server, no database).
import { describe, expect, test } from "bun:test";
import * as Schema from "effect/Schema";
import { OpenApi } from "effect/http-api";
import { defineCommand, emit, fail } from "@crablet/commands/Command";
import { DomainError } from "@crablet/commands/Errors";
import { defineEvent } from "@crablet/commands/Event";
import { makeCommandApi } from "../src/CommandApi.ts";
import { exposedCommandOf, type ExposedCommand } from "../src/ExposedCommand.ts";
import { inputJsonSchemaProblems } from "../src/InputJsonSchema.ts";

class WalletNotFound extends DomainError("WalletNotFound", { fields: { walletId: Schema.String }, kind: "not_found" }) {}
class InsufficientFunds extends DomainError("InsufficientFunds", {
  fields: { walletId: Schema.String, balance: Schema.Number },
  kind: "invalid"
}) {}
const Done = defineEvent("Done", { schema: Schema.Struct({ walletId: Schema.String }), tags: (d) => ({ wallet_id: d.walletId }) });

const Deposit = defineCommand({
  name: "deposit",
  errors: [WalletNotFound],
  input: Schema.Struct({ walletId: Schema.String, amount: Schema.Finite.check(Schema.isGreaterThan(0)) }),
  decide: (_, c) => (c.walletId === "x" ? fail(new WalletNotFound({ walletId: c.walletId })) : emit(Done({ walletId: c.walletId })))
});
const Withdraw = defineCommand({
  name: "withdraw",
  errors: [WalletNotFound, InsufficientFunds],
  input: Schema.Struct({ walletId: Schema.String, amount: Schema.Finite }),
  decide: (_, c) =>
    c.amount > 1 ? fail(new InsufficientFunds({ walletId: c.walletId, balance: 0 })) : fail(new WalletNotFound({ walletId: c.walletId }))
});
const Open = defineCommand({ name: "open", input: Schema.Struct({ walletId: Schema.String }), decide: (_, c) => emit(Done(c)) });

const registry: Readonly<Record<string, ExposedCommand<any, any>>> = {
  deposit: exposedCommandOf(Deposit),
  withdraw: exposedCommandOf(Withdraw),
  open: exposedCommandOf(Open)
};

const spec = OpenApi.fromApi(makeCommandApi("/api/commands", registry)) as any;
const post = (name: string) => spec.paths[`/api/commands/${name}`].post;

describe("the API description of the command routes", () => {
  test("one POST route per command, plus the listing", () => {
    expect(Object.keys(spec.paths).sort()).toEqual(["/api/commands", "/api/commands/deposit", "/api/commands/open", "/api/commands/withdraw"]);
    expect(spec.paths["/api/commands"].get).toBeDefined();
  });

  test("each route's request body is the command's own input schema, constraints included", () => {
    const body = post("deposit").requestBody.content["application/json"].schema;
    expect(body.required).toEqual(["walletId", "amount"]);
    expect(body.properties.amount).toEqual({ type: "number", exclusiveMinimum: 0 });
    expect(post("open").requestBody.content["application/json"].schema.required).toEqual(["walletId"]);
  });

  test("success responses: 201 when created, 200 for an idempotent repeat", () => {
    const responses = post("deposit").responses;
    expect(Object.keys(responses)).toEqual(expect.arrayContaining(["201", "200"]));
  });

  test("failures: the framework's own on every route, a command's declared errors only on its own", () => {
    const statuses = (name: string) => Object.keys(post(name).responses).sort();
    // open: bad payload 400, stale decision 409, unexpected 500
    expect(statuses("open")).toEqual(["200", "201", "400", "409", "500"]);
    // deposit adds WalletNotFound (404); withdraw adds it and InsufficientFunds (kind invalid -> 400)
    expect(statuses("deposit")).toEqual(["200", "201", "400", "404", "409", "500"]);
    expect(statuses("withdraw")).toEqual(["200", "201", "400", "404", "409", "500"]);
  });

  test("problems are application/problem+json; a declared error is its own typed component", () => {
    const notFound = post("deposit").responses["404"].content;
    expect(Object.keys(notFound)).toEqual(["application/problem+json"]);
    expect(notFound["application/problem+json"].schema).toEqual({ $ref: "#/components/schemas/WalletNotFoundProblem" });

    const component = spec.components.schemas.WalletNotFoundProblem;
    expect(component.properties.errorType).toEqual({ type: "string", enum: ["WalletNotFound"] });
    expect(component.properties.fields.properties.walletId).toEqual({ type: "string" });
    expect(Object.keys(spec.components.schemas)).toContain("InsufficientFundsProblem");
  });

  test("the same error class is ONE component shared by every route that declares it", () => {
    const ref = (name: string) => post(name).responses["404"].content["application/problem+json"].schema.$ref;
    expect(ref("deposit")).toBe(ref("withdraw"));
  });
});

describe("how optional fields are described", () => {
  const specOf = (input: Schema.Constraint) => {
    const command = defineCommand({ name: "probe", input, decide: (_: unknown, c: any) => emit(Done({ walletId: String(c.id) })) });
    const api = OpenApi.fromApi(makeCommandApi("/api/commands", { probe: exposedCommandOf(command as never) })) as any;
    return api.paths["/api/commands/probe"].post.requestBody.content["application/json"].schema;
  };

  test("Schema.optionalKey: not required, and described as its own type", () => {
    const body = specOf(Schema.Struct({ id: Schema.String, note: Schema.optionalKey(Schema.String), count: Schema.optionalKey(Schema.Int) }));
    expect(body.required).toEqual(["id"]);
    expect(body.properties.note).toEqual({ type: "string" });
    expect(body.properties.count).toEqual({ type: "integer" });
  });

  test("Schema.optional is described as nullable, which the decoder would refuse: the lint reports it", () => {
    const input = Schema.Struct({ id: Schema.String, note: Schema.optional(Schema.String), nested: Schema.Struct({ deep: Schema.optional(Schema.Int) }) });
    expect(specOf(input).properties.note).toEqual({ anyOf: [{ type: "string" }, { type: "null" }] });

    const command = defineCommand({ name: "probe", input, decide: (_, c) => emit(Done({ walletId: c.id })) });
    const problems = inputJsonSchemaProblems(command);
    expect(problems).toHaveLength(2);
    expect(problems.join("\n")).toContain('field "note"');
    expect(problems.join("\n")).toContain('field "nested.deep"');
  });

  test("a legitimate NullOr is not flagged", () => {
    const command = defineCommand({ name: "probe", input: Schema.Struct({ id: Schema.String, memo: Schema.NullOr(Schema.String) }), decide: (_, c) => emit(Done({ walletId: c.id })) });
    expect(inputJsonSchemaProblems(command)).toEqual([]);
  });

  test("the description accepts no properties the command does not declare", () => {
    expect(specOf(Schema.Struct({ id: Schema.String })).additionalProperties).toBe(false);
  });
});
