import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import * as Schema from "effect/Schema";
import { Duplicate } from "@crablet/eventstore/AppendErrors";
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
const Audited = defineEvent("Audited", { schema: Schema.Struct({ id: Schema.String }), tags: (d) => ({ account_id: d.id }) });

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

  test('onDuplicate "fail": a repeat fails with Duplicate', async () => {
    const Strict = defineCommand({
      name: "withdraw-once",
      input: Schema.Struct({ id: Schema.String, amount: Positive, opId: Schema.String }),
      model: (c) => AccountModel.of({ id: c.id }),
      idempotentBy: (c) => Withdrawn.where({ op_id: c.opId }),
      onDuplicate: "fail",
      decide: (_, c) => emit(Withdrawn(c))
    });
    const scenario = given(Opened({ id: "a1", initial: 100 }));
    await scenario.when(Strict, { id: "a1", amount: 1, opId: "op1" });
    const again = await scenario.when(Strict, { id: "a1", amount: 1, opId: "op1" });
    expect(again.error).toBeInstanceOf(Duplicate);
  });

  test("a command that fails AFTER its prepare step appended something leaves no trace (transaction rollback)", async () => {
    const Audit = defineCommand({
      name: "audited-withdraw",
      errors: [NoSuchAccount],
      input: Schema.Struct({ id: Schema.String }),
      // prepare writes an audit event - then decide refuses
      prepare: (c, es) => es.append([Audited({ id: c.id })]),
      decide: (_, c) => fail(new NoSuchAccount({ id: c.id })),
      consistency: () => concurrent()
    });
    const scenario = given(Opened({ id: "a1", initial: 5 }));
    const result = await scenario.when(Audit, { id: "a1" });
    expect(result.error).toBeInstanceOf(NoSuchAccount);
    expect(scenario.log.map((e) => e.type)).toEqual(["Opened"]); // the audit event was rolled back
    expect(scenario.store.appended).toHaveLength(0);
  });

  test("a successful command keeps what its prepare step appended, alongside its own events", async () => {
    const Audit = defineCommand({
      name: "audited",
      input: Schema.Struct({ id: Schema.String, amount: Positive, opId: Schema.String }),
      prepare: (c, es) => es.append([Audited({ id: c.id })]),
      model: (c) => AccountModel.of({ id: c.id }),
      decide: (_, c) => emit(Withdrawn(c))
    });
    const result = await given(Opened({ id: "a1", initial: 5 })).when(Audit, { id: "a1", amount: 1, opId: "x" });
    expect(result.outcome).toBe("created");
    expect(result.events.map((e) => e.type)).toEqual(["Audited", "Withdrawn"]);
  });

  test("a command that ends idempotent after its prepare step appended something fails the test: that transaction would commit with no audit row", async () => {
    const Leaky = defineCommand({
      name: "leaky",
      input: Schema.Struct({ id: Schema.String }),
      prepare: (c, es) => es.append([Audited({ id: c.id })]),
      model: (c) => AccountModel.of({ id: c.id }),
      decide: () => noop("NOTHING_TO_DO")
    });
    await expect(given(Opened({ id: "a1", initial: 5 })).when(Leaky, { id: "a1" })).rejects.toThrow(/leaky.*prepare.*appended/s);
  });

  test("an idempotent outcome whose prepare step appended nothing is fine", async () => {
    const Quiet = defineCommand({
      name: "quiet",
      input: Schema.Struct({ id: Schema.String }),
      prepare: (c, es) => es.exists(Opened.where({ account_id: c.id })),
      decide: () => noop("NOTHING_TO_DO")
    });
    const result = await given(Opened({ id: "a1", initial: 5 })).when(Quiet, { id: "a1" });
    expect(result.outcome).toBe("idempotent");
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
