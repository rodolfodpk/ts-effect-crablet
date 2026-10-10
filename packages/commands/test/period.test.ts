// `.period`: a model that declares its period once, and a command that never writes the rollover itself (docs/plans/period-rollover.md). In memory, with a clock: `given(...).at(date).when(...)`.
import { describe, expect, test } from "bun:test";
import * as Schema from "effect/Schema";
import { defineCommand, emit, fail, noop } from "../src/Command.ts";
import { DomainError } from "../src/Errors.ts";
import { defineEvent } from "../src/Event.ts";
import { defineModel } from "../src/Model.ts";
import { Period } from "../src/Period.ts";
import { given } from "../src/testing/Scenario.ts";

const Opened = defineEvent("PX_Opened", { schema: Schema.Struct({ id: Schema.String }), tags: (d) => ({ acct: d.id }) });
const Credited = defineEvent("PX_Credited", { schema: Schema.Struct({ id: Schema.String, amount: Schema.Number, opId: Schema.String }), tags: (d) => ({ acct: d.id, op_id: d.opId }) });
const PeriodOpened = defineEvent("PX_PeriodOpened", {
  schema: Schema.Struct({ id: Schema.String, year: Schema.Number, month: Schema.Number, day: Schema.optional(Schema.Number), opening: Schema.Number }),
  tags: (d) => ({ acct: d.id, year: d.year, month: d.month, day: d.day })
});
const PeriodClosed = defineEvent("PX_PeriodClosed", {
  schema: Schema.Struct({ id: Schema.String, year: Schema.Number, month: Schema.Number, day: Schema.optional(Schema.Number), closing: Schema.Number }),
  tags: (d) => ({ acct: d.id, year: d.year, month: d.month, day: d.day })
});

const base = defineModel({ by: "acct", initial: () => ({ exists: false, balance: 0 }) })
  .lifecycle(Opened, () => ({ exists: true, balance: 0 }))
  .on(PeriodOpened, (a, d) => ({ ...a, balance: d.opening }))
  .on(Credited, (a, d) => ({ ...a, balance: a.balance + d.amount }));

const Monthly = base.period(Period.month, {
  opened: PeriodOpened,
  closed: PeriodClosed,
  open: (carry, p) => ({ id: p.id, year: p.fields.year, month: p.fields.month, opening: carry.balance }),
  close: (state, p) => ({ id: p.id, year: p.fields.year, month: p.fields.month, closing: state.balance })
});
const Daily = base.period(Period.day, {
  opened: PeriodOpened,
  closed: PeriodClosed,
  open: (carry, p) => ({ id: p.id, ...p.fields, opening: carry.balance }),
  close: (state, p) => ({ id: p.id, ...p.fields, closing: state.balance })
});

class NoSuchAccount extends DomainError("NoSuchAccount", { fields: { id: Schema.String }, kind: "not_found" }) {}
const input = Schema.Struct({ id: Schema.String, amount: Schema.Number, opId: Schema.String });
const credit = (model: typeof Monthly) =>
  defineCommand({
    name: "px_credit",
    input,
    errors: [NoSuchAccount],
    model: (c) => model.of({ id: c.id }),
    idempotentBy: (c) => Credited.where({ op_id: c.opId }),
    decide: (a, c) => (a.exists ? emit(Credited(c, a.period.tags)) : fail(new NoSuchAccount({ id: c.id })))
  });
const Credit = credit(Monthly);
const CreditDaily = credit(Daily as never);
const noopCmd = defineCommand({ name: "px_noop", input, model: (c) => Monthly.of({ id: c.id }), decide: () => noop("nothing") });

const oct = new Date(Date.UTC(2026, 9, 9, 12));
const nov = new Date(Date.UTC(2026, 10, 2, 12));
const dec = new Date(Date.UTC(2026, 11, 5, 12));
const c = (amount: number, opId: string) => ({ id: "a1", amount, opId });
const types = (r: { events: ReadonlyArray<{ type: string }> }) => r.events.map((e) => e.type);

describe("a model with a period", () => {
  test("the first command of an account opens the first period, in the same append as its own event", async () => {
    const r = await given(Opened({ id: "a1" })).at(oct).when(Credit, c(10, "o1"));
    expect(r.outcome).toBe("created");
    expect(types(r)).toEqual(["PX_PeriodOpened", "PX_Credited"]);
    expect(r.events[0]!.data).toMatchObject({ year: 2026, month: 10, opening: 0 });
    expect(r.events[1]!.tags.map((t) => `${t.key}=${t.value}`)).toContain("month=10");
  });

  test("a second command in the same period opens nothing", async () => {
    const s = given(Opened({ id: "a1" })).at(oct);
    await s.when(Credit, c(10, "o1"));
    const r = await s.when(Credit, c(5, "o2"));
    expect(types(r)).toEqual(["PX_Credited"]);
  });

  test("the first command of the next period closes the old one and opens the new one with the balance carried forward", async () => {
    const s = given(Opened({ id: "a1" }));
    await s.at(oct).when(Credit, c(10, "o1"));
    const r = await s.at(nov).when(Credit, c(5, "o2"));
    expect(types(r)).toEqual(["PX_PeriodClosed", "PX_PeriodOpened", "PX_Credited"]);
    expect(r.events[0]!.data).toMatchObject({ month: 10, closing: 10 });
    expect(r.events[1]!.data).toMatchObject({ month: 11, opening: 10 });
    expect(r.events[2]!.data).toMatchObject({ amount: 5 });
    const again = await s.at(nov).when(Credit, c(1, "o3"));
    expect(types(again)).toEqual(["PX_Credited"]);
  });

  test("an idle account jumps straight to the current period: one closing, one opening", async () => {
    const s = given(Opened({ id: "a1" }));
    await s.at(oct).when(Credit, c(10, "o1"));
    const r = await s.at(dec).when(Credit, c(5, "o2"));
    expect(types(r)).toEqual(["PX_PeriodClosed", "PX_PeriodOpened", "PX_Credited"]);
    expect(r.events[1]!.data).toMatchObject({ month: 12, opening: 10 });
  });

  test("a clock behind the open period never turns it back: the command lands in the open period", async () => {
    const s = given(Opened({ id: "a1" }));
    await s.at(oct).when(Credit, c(10, "o1"));
    await s.at(nov).when(Credit, c(5, "o2"));
    const r = await s.at(oct).when(Credit, c(7, "o3")); // a pod that still believes it is October
    expect(types(r)).toEqual(["PX_Credited"]);
    expect(r.events[0]!.tags.map((t) => `${t.key}=${t.value}`)).toContain("month=11");
  });

  test("a refused command writes nothing of the rollover", async () => {
    const s = given(Opened({ id: "a1" }));
    await s.at(oct).when(Credit, c(10, "o1"));
    const before = s.log.length;
    const r = await s.at(nov).when(Credit, { id: "ghost", amount: 1, opId: "o9" });
    expect(r.error).toBeInstanceOf(NoSuchAccount);
    expect(s.log.length).toBe(before);
  });

  test("a repeat and a no-op in the new period write nothing of the rollover", async () => {
    const s = given(Opened({ id: "a1" }));
    await s.at(oct).when(Credit, c(10, "o1"));
    const before = s.log.length;
    expect((await s.at(nov).when(Credit, c(10, "o1"))).outcome).toBe("idempotent");
    expect((await s.at(nov).when(noopCmd, c(1, "x"))).outcome).toBe("idempotent");
    expect(s.log.length).toBe(before);
  });

  test("the same model on a daily period turns every day, with the day in the tags", async () => {
    const s = given(Opened({ id: "a1" }));
    const d1 = new Date(Date.UTC(2026, 9, 9, 23, 59));
    const d2 = new Date(Date.UTC(2026, 9, 10, 0, 1));
    await s.at(d1).when(CreditDaily, c(10, "o1"));
    const r = await s.at(d2).when(CreditDaily, c(5, "o2"));
    expect(types(r)).toEqual(["PX_PeriodClosed", "PX_PeriodOpened", "PX_Credited"]);
    expect(r.events[1]!.data).toMatchObject({ month: 10, day: 10, opening: 10 });
    expect(r.events[2]!.tags.map((t) => `${t.key}=${t.value}`)).toContain("day=10");
  });

  test("a model that does not handle its opening event is refused when it is defined", () => {
    const bare = defineModel({ by: "acct", initial: () => ({ balance: 0 }) });
    expect(() => bare.period(Period.month, { opened: PeriodOpened, closed: PeriodClosed, open: () => ({} as never), close: () => ({} as never) })).toThrow(/PX_PeriodOpened/);
  });

  test("an opening event that does not carry the tags of its period is refused the first time the period is turned, naming the tag", async () => {
    // a period whose events cannot be found again would be opened again by every command: the framework checks the tags of the events it builds
    const Bare = defineEvent("PX_BareOpened", { schema: Schema.Struct({ id: Schema.String, year: Schema.Number, month: Schema.Number, opening: Schema.Number }), tags: (d) => ({ acct: d.id }) });
    const bareModel = defineModel({ by: "acct", initial: () => ({ exists: false, balance: 0 }) })
      .lifecycle(Opened, () => ({ exists: true, balance: 0 }))
      .on(Bare, (a, d) => ({ ...a, balance: d.opening }))
      .period(Period.month, {
        opened: Bare,
        closed: PeriodClosed,
        open: (carry, p) => ({ id: p.id, year: p.fields.year, month: p.fields.month, opening: carry.balance }),
        close: (state, p) => ({ id: p.id, year: p.fields.year, month: p.fields.month, closing: state.balance })
      });
    const Cmd = defineCommand({ name: "px_bare", input, errors: [NoSuchAccount], model: (cc) => bareModel.of({ id: cc.id }), decide: (a, cc) => (a.exists ? emit(Credited(cc, a.period.tags)) : fail(new NoSuchAccount({ id: cc.id }))) });
    await expect(given(Opened({ id: "a1" })).at(oct).when(Cmd, c(1, "o1"))).rejects.toThrow(/PX_BareOpened.*"year"/s);
  });
});
