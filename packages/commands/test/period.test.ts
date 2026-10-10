// `.period`: a model that declares its period once, and a command that never writes the rollover itself (docs/plans/period-rollover.md). In memory, with a clock: `given(...).at(date).when(...)`.
import { describe, expect, test } from "bun:test";
import { Effect, Metric } from "effect";
import * as Schema from "effect/Schema";
import * as PeriodMetrics from "@crablet/metrics-otel/PeriodMetrics";
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

  test("Period.custom: a fiscal year that starts in April turns on 1 April, not on 1 January", async () => {
    // fiscal year N runs from April of N to March of N+1; its fields are { fy }
    const fiscal = Period.custom({
      fieldsAt: (now: Date) => ({ fy: now.getUTCMonth() >= 3 ? now.getUTCFullYear() : now.getUTCFullYear() - 1 }),
      fieldsOf: (data: unknown) => {
        const fy = (data as { fy?: unknown } | null)?.fy;
        return typeof fy === "number" ? { fy } : null;
      },
      key: (f: { readonly fy: number }) => `FY${f.fy}`,
      tagKeys: ["fy"]
    });
    const FyOpened = defineEvent("PX_FyOpened", { schema: Schema.Struct({ id: Schema.String, fy: Schema.Number, opening: Schema.Number }), tags: (d) => ({ acct: d.id, fy: d.fy }) });
    const FyClosed = defineEvent("PX_FyClosed", { schema: Schema.Struct({ id: Schema.String, fy: Schema.Number, closing: Schema.Number }), tags: (d) => ({ acct: d.id, fy: d.fy }) });
    const FyCredited = defineEvent("PX_FyCredited", { schema: Schema.Struct({ id: Schema.String, amount: Schema.Number }), tags: (d) => ({ acct: d.id }) });
    const Fiscal = defineModel({ by: "acct", initial: () => ({ exists: false, balance: 0 }) })
      .lifecycle(Opened, () => ({ exists: true, balance: 0 }))
      .on(FyOpened, (a, d) => ({ ...a, balance: d.opening }))
      .on(FyCredited, (a, d) => ({ ...a, balance: a.balance + d.amount }))
      .period(fiscal, {
        opened: FyOpened,
        closed: FyClosed,
        open: (carry, p) => ({ id: p.id, fy: p.fields.fy, opening: carry.balance }),
        close: (state, p) => ({ id: p.id, fy: p.fields.fy, closing: state.balance })
      });
    const Add = defineCommand({
      name: "px_fy_credit",
      input,
      errors: [NoSuchAccount],
      model: (cc) => Fiscal.of({ id: cc.id }),
      decide: (a, cc) => (a.exists ? emit(FyCredited({ id: cc.id, amount: cc.amount }, a.period.tags)) : fail(new NoSuchAccount({ id: cc.id })))
    });
    const s = given(Opened({ id: "a1" }));
    const march = new Date(Date.UTC(2027, 2, 31, 12));
    const april = new Date(Date.UTC(2027, 3, 1, 12));
    const first = await s.at(march).when(Add, c(10, "o1"));
    expect(types(first)).toEqual(["PX_FyOpened", "PX_FyCredited"]);
    expect(first.events[0]!.data).toMatchObject({ fy: 2026, opening: 0 });
    // 1 January is the same fiscal year: nothing turns
    expect(types(await s.at(new Date(Date.UTC(2027, 0, 1, 12))).when(Add, c(1, "o2")))).toEqual(["PX_FyCredited"]);
    // 1 April is the next one
    const turned = await s.at(april).when(Add, c(5, "o3"));
    expect(types(turned)).toEqual(["PX_FyClosed", "PX_FyOpened", "PX_FyCredited"]);
    expect(turned.events[0]!.data).toMatchObject({ fy: 2026, closing: 11 });
    expect(turned.events[1]!.data).toMatchObject({ fy: 2027, opening: 11 });
    // a pod whose clock is still in March never turns it back
    expect(types(await s.at(march).when(Add, c(2, "o4")))).toEqual(["PX_FyCredited"]);
  });

  test("decide gets the instant the period was decided at: the clock, once, the same for the period's events and the command's own", async () => {
    const Stamped = defineEvent("PX_Stamped", { schema: Schema.Struct({ id: Schema.String, at: Schema.String }), tags: (d) => ({ acct: d.id }) });
    const Stamp = defineCommand({
      name: "px_stamp",
      input,
      errors: [NoSuchAccount],
      model: (cc) => Monthly.of({ id: cc.id }),
      decide: (a, cc, _prepared, { now }) => (a.exists ? emit(Stamped({ id: cc.id, at: now.toISOString() }, a.period.tags)) : fail(new NoSuchAccount({ id: cc.id })))
    });
    const r = await given(Opened({ id: "a1" })).at(nov).when(Stamp, c(1, "o1"));
    expect(types(r)).toEqual(["PX_PeriodOpened", "PX_Stamped"]);
    expect(r.events[1]!.data).toMatchObject({ at: nov.toISOString() });
  });

  test("a command without a period model gets the clock as `now` too", async () => {
    const Plain = defineEvent("PX_Plain", { schema: Schema.Struct({ at: Schema.String }), tags: () => ({ acct: "x" }) });
    const Cmd = defineCommand({ name: "px_plain", input, decide: (_s, _c, _p, { now }) => emit(Plain({ at: now.toISOString() })) });
    const r = await given().at(dec).when(Cmd, c(1, "o1"));
    expect(r.events[0]!.data).toMatchObject({ at: dec.toISOString() });
  });

  test("a clock behind the open period is counted: crablet.period.clock_behind", async () => {
    const count = () => Effect.runPromise(Metric.value(PeriodMetrics.clockBehind)).then((m) => (m as unknown as { count: number }).count);
    const s = given(Opened({ id: "a1" }));
    await s.at(nov).when(Credit, c(10, "o1"));
    const before = await count();
    await s.at(oct).when(Credit, c(1, "o2")); // behind
    await s.at(nov).when(Credit, c(1, "o3")); // not behind
    expect(await count()).toBe(before + 1);
  });
});
