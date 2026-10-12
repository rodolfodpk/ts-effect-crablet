import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import * as Schema from "effect/Schema";
import { concurrent, defineCommand, emit, fail, noop } from "../src/Command.ts";
import { DomainError, InvalidInput } from "../src/Errors.ts";
import { defineEvent } from "../src/Event.ts";
import { defineModel } from "../src/Model.ts";
import { given } from "../src/testing/Scenario.ts";

// A small banking-ish domain, tested the BDD way: given a history, when a command arrives, then ...
const Opened = defineEvent("Opened", {
  schema: Schema.Struct({ id: Schema.String, initial: Schema.Number }),
  tags: (d) => ({ account_id: d.id })
});
const Withdrawn = defineEvent("Withdrawn", {
  schema: Schema.Struct({ id: Schema.String, amount: Schema.Number, opId: Schema.String }),
  tags: (d) => ({ account_id: d.id, op_id: d.opId })
});

const AccountModel = defineModel({ by: "account_id", initial: () => ({ open: false, balance: 0 }) })
  .lifecycle(Opened, (_, d) => ({ open: true, balance: d.initial }))
  .on(Withdrawn, (a, d) => ({ ...a, balance: a.balance - d.amount }));

class NoSuchAccount extends DomainError("NoSuchAccount", { fields: { id: Schema.String }, kind: "not_found" }) {}
class Overdrawn extends DomainError("Overdrawn", {
  fields: { balance: Schema.Number, wanted: Schema.Number },
  kind: "invalid"
}) {}

const Positive = Schema.Number.check(Schema.isGreaterThan(0));
const Withdraw = defineCommand({
  name: "withdraw",
  errors: [NoSuchAccount, Overdrawn],
  input: Schema.Struct({ id: Schema.String, amount: Positive, opId: Schema.String }),
  model: (c) => AccountModel.of({ id: c.id }),
  idempotentBy: (c) => Withdrawn.where({ op_id: c.opId }),
  decide: (account, c) =>
    !account.open
      ? fail(new NoSuchAccount({ id: c.id }))
      : account.balance < c.amount
        ? fail(new Overdrawn({ balance: account.balance, wanted: c.amount }))
        : emit(Withdrawn(c))
});

describe("given / when: command logic without a database", () => {
  test("a valid command appends its event, and only that event", async () => {
    const result = await given(Opened({ id: "a1", initial: 100 })).when(Withdraw, { id: "a1", amount: 30, opId: "op1" });
    expect(result.outcome).toBe("created");
    expect(result.events.map((e) => e.type)).toEqual(["Withdrawn"]);
    expect(result.events[0]!.data).toEqual({ id: "a1", amount: 30, opId: "op1" });
    expect(result.events[0]!.tags.map((t) => `${t.key}=${t.value}`)).toEqual(["account_id=a1", "op_id=op1"]);
    expect(result.error).toBeUndefined();
  });

  test("a rule refusal is a typed failure carrying its fields, and appends nothing", async () => {
    const scenario = given(Opened({ id: "a1", initial: 10 }));
    const result = await scenario.when(Withdraw, { id: "a1", amount: 50, opId: "op1" });
    expect(result.outcome).toBe("failed");
    expect(result.error).toBeInstanceOf(Overdrawn);
    expect((result.error as Overdrawn).balance).toBe(10);
    expect(result.events).toEqual([]);
    expect(scenario.log).toHaveLength(1);

    const unknown = await given().when(Withdraw, { id: "ghost", amount: 1, opId: "op2" });
    expect(unknown.error).toBeInstanceOf(NoSuchAccount);
  });

  test("malformed input is InvalidInput (and never reaches decide)", async () => {
    const result = await given(Opened({ id: "a1", initial: 100 })).when(Withdraw, { id: "a1", amount: -5, opId: "op1" });
    expect(result.outcome).toBe("failed");
    expect(result.error).toBeInstanceOf(InvalidInput);
  });

  test("later whens see earlier ones: state accumulates, and an exact repeat is idempotent", async () => {
    const scenario = given(Opened({ id: "a1", initial: 100 }));
    expect((await scenario.when(Withdraw, { id: "a1", amount: 60, opId: "op1" })).outcome).toBe("created");

    // 60 already withdrawn, so 60 more would overdraw...
    const overdraw = await scenario.when(Withdraw, { id: "a1", amount: 60, opId: "op2" });
    expect(overdraw.error).toBeInstanceOf(Overdrawn);
    expect((overdraw.error as Overdrawn).balance).toBe(40);

    // ...but repeating the FIRST operation is "already done", not an overdraw (idempotency is checked before deciding)
    const repeat = await scenario.when(Withdraw, { id: "a1", amount: 60, opId: "op1" });
    expect(repeat.outcome).toBe("idempotent");
    expect(repeat.reason).toBe("DUPLICATE_OPERATION");
    expect(repeat.events).toEqual([]);
    expect(scenario.log.map((e) => e.type)).toEqual(["Opened", "Withdrawn"]);
  });

  test("a refused command leaves no trace", async () => {
    const Refuse = defineCommand({
      name: "refuse",
      errors: [NoSuchAccount],
      input: Schema.Struct({ id: Schema.String }),
      decide: (_, c) => fail(new NoSuchAccount({ id: c.id }))
    });
    const scenario = given(Opened({ id: "a1", initial: 5 }));
    const result = await scenario.when(Refuse, { id: "a1" });
    expect(result.error).toBeInstanceOf(NoSuchAccount);
    expect(scenario.log.map((e) => e.type)).toEqual(["Opened"]);
    expect(scenario.store.appended).toHaveLength(0);
  });

  test("a lookup in resolve reaches decide; an idempotent outcome after it appends nothing", async () => {
    const Quiet = defineCommand({
      name: "quiet",
      input: Schema.Struct({ id: Schema.String }),
      resolve: (c, read) => read.exists(Opened.where({ account_id: c.id })),
      decide: (_, c, { resolved }) => (resolved ? noop("NOTHING_TO_DO") : fail(new NoSuchAccount({ id: c.id }))),
      errors: [NoSuchAccount]
    });
    const result = await given(Opened({ id: "a1", initial: 5 })).when(Quiet, { id: "a1" });
    expect(result.outcome).toBe("idempotent");
    expect((await given().when(Quiet, { id: "a1" })).error).toBeInstanceOf(NoSuchAccount);
  });

  test("a bug in a command (a defect) fails the test loudly instead of becoming a result", async () => {
    const Broken = defineCommand({
      name: "broken",
      input: Schema.Struct({ id: Schema.String }),
      decide: () => {
        throw new Error("boom");
      }
    });
    await expect(given().when(Broken, { id: "x" })).rejects.toThrow(/boom/);
  });
});
