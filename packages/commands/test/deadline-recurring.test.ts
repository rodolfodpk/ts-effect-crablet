// An acceptance test of deadlines (ADR-0043) on a recurring case: a plan charged every month, with no primitive for recurrence. Each charge sets the
// deadline of the next one, so the recurrence is a chain of facts in the log, and it lasts as long as the model says the plan is active. In memory,
// through Scenario.fireDue.
//
// What it shows: the due time of period n is computed from the plan's anchor, so a late firing does not push the next ones and a month end does not
// drift; the period number in the input makes a repeat and a stale deadline harmless; cancelling ends the chain with nothing to cancel; a change of plan
// supersedes the deadlines already set; and periods missed while nothing fired are caught up, one firing at a time.
import { describe, expect, test } from "bun:test";
import { DateTime } from "effect";
import * as Schema from "effect/Schema";
import { byModel, deadline, defineCommand, defineEvent, defineModel, emit, Instant, noop, type Command } from "../src/Domain.ts";
import { given, type Scenario } from "../src/testing/Scenario.ts";

const PlanStarted = defineEvent("RcPlanStarted", {
  schema: Schema.Struct({ planId: Schema.String, amount: Schema.Int, anchor: Instant }),
  tags: (d) => ({ plan_id: d.planId })
});
// A new price from the next period on. `version` names the schedule the deadlines belong to.
const PlanChanged = defineEvent("RcPlanChanged", {
  schema: Schema.Struct({ planId: Schema.String, amount: Schema.Int, version: Schema.Int }),
  tags: (d) => ({ plan_id: d.planId })
});
const PeriodCharged = defineEvent("RcPeriodCharged", {
  schema: Schema.Struct({ planId: Schema.String, period: Schema.Int, amount: Schema.Int, dueAt: Instant }),
  tags: (d) => ({ plan_id: d.planId })
});
const PlanCancelled = defineEvent("RcPlanCancelled", { schema: Schema.Struct({ planId: Schema.String }), tags: (d) => ({ plan_id: d.planId }) });

const Plan = defineModel({
  by: "plan_id",
  initial: () => ({ status: "none" as "none" | "active" | "cancelled", amount: 0, anchor: null as DateTime.Utc | null, version: 0, lastCharged: 0 })
})
  .on(PlanStarted, (_s, d) => ({ status: "active" as const, amount: d.amount, anchor: d.anchor, version: 1, lastCharged: 0 }))
  .on(PlanChanged, (s, d) => ({ ...s, amount: d.amount, version: d.version }))
  .on(PeriodCharged, (s, d) => ({ ...s, lastCharged: d.period }))
  .on(PlanCancelled, (s) => ({ ...s, status: "cancelled" as const }));

// Period n falls due n months after the anchor: from the anchor, never from the last due time (a chain of "+1 month" sticks at the 28th after February).
const dueOf = (anchor: DateTime.Utc, period: number) => DateTime.add(anchor, { months: period });

// A command that sets its own next deadline names itself in `decide`, so TypeScript cannot infer its type from its own initializer: annotate it, from its
// input schema (it fails with no domain error).
const chargeInput = Schema.Struct({ planId: Schema.String, period: Schema.Int, version: Schema.Int });
const ChargePeriod: Command<typeof chargeInput.Type, never, typeof chargeInput> = defineCommand({
  name: "rc_charge_period",
  input: chargeInput,
  model: (c) => Plan.of({ id: c.planId }),
  idempotentBy: byModel(),
  decide: (p, c) =>
    p.status !== "active"
      ? noop("NOT_ACTIVE")
      : c.period <= p.lastCharged
        ? noop("ALREADY_CHARGED")
        : c.version !== p.version
          ? noop("SUPERSEDED")
          : emit(
              PeriodCharged({ planId: c.planId, period: c.period, amount: p.amount, dueAt: dueOf(p.anchor!, c.period) }),
              deadline(ChargePeriod, { planId: c.planId, period: c.period + 1, version: p.version }, { at: dueOf(p.anchor!, c.period + 1) })
            )
});

const StartPlan = defineCommand({
  name: "rc_start_plan",
  input: Schema.Struct({ planId: Schema.String, amount: Schema.Int }),
  model: (c) => Plan.of({ id: c.planId }),
  idempotentBy: byModel(),
  decide: (p, c, { now }) =>
    p.status !== "none"
      ? noop("ALREADY_STARTED")
      : emit(PlanStarted({ ...c, anchor: now }), deadline(ChargePeriod, { planId: c.planId, period: 1, version: 1 }, { at: dueOf(now, 1) }))
});

// The next charge at the new price, on the same calendar: the current deadline belongs to the old version and answers SUPERSEDED.
const ChangePlan = defineCommand({
  name: "rc_change_plan",
  input: Schema.Struct({ planId: Schema.String, amount: Schema.Int }),
  model: (c) => Plan.of({ id: c.planId }),
  idempotentBy: byModel(),
  decide: (p, c) =>
    p.status !== "active"
      ? noop("NOT_ACTIVE")
      : p.amount === c.amount
        ? noop("SAME_PRICE")
        : emit(
            PlanChanged({ planId: c.planId, amount: c.amount, version: p.version + 1 }),
            deadline(ChargePeriod, { planId: c.planId, period: p.lastCharged + 1, version: p.version + 1 }, { at: dueOf(p.anchor!, p.lastCharged + 1) })
          )
});

const CancelPlan = defineCommand({
  name: "rc_cancel_plan",
  input: Schema.Struct({ planId: Schema.String }),
  model: (c) => Plan.of({ id: c.planId }),
  idempotentBy: byModel(),
  decide: (p, c) => (p.status === "cancelled" ? noop("ALREADY_CANCELLED") : emit(PlanCancelled(c)))
});

const anchor = DateTime.makeUnsafe("2026-01-31T09:00:00.000Z");
const at = (iso: string) => DateTime.makeUnsafe(iso);
const charges = (s: Scenario) =>
  s.log.filter((e) => e.type === PeriodCharged.type).map((e) => e.data as { period: number; amount: number; dueAt: string }).map((d) => [d.period, d.amount, d.dueAt.slice(0, 10)]);

describe("a monthly plan as a chain of deadlines", () => {
  test("each charge sets the next; the due dates come from the anchor, so a month end does not drift and a late firing does not push the next", async () => {
    const s = given();
    await s.at(anchor).when(StartPlan, { planId: "p1", amount: 900 });
    // Each period fires a little late (on the 1st and 2nd of the month, not at the end of the previous one): the due dates stay on the anchor's calendar.
    for (const now of ["2026-03-01T00:00:00Z", "2026-04-01T00:00:00Z", "2026-05-02T00:00:00Z"]) {
      expect((await s.at(at(now)).fireDue(ChargePeriod)).map((f) => f.outcome)).toEqual(["appended"]);
    }
    expect(charges(s)).toEqual([[1, 900, "2026-02-28"], [2, 900, "2026-03-31"], [3, 900, "2026-04-30"]]);
    // Before the fourth falls due, nothing fires.
    expect(await s.at(at("2026-05-30T00:00:00Z")).fireDue(ChargePeriod)).toEqual([]);
  });

  test("a deadline that fires twice charges once", async () => {
    const s = given();
    await s.at(anchor).when(StartPlan, { planId: "p1", amount: 900 });
    await s.at(at("2026-03-01T00:00:00Z")).fireDue(ChargePeriod);
    // The same deadline again (a crash before its firing was recorded): run its command as the processor would.
    const again = await s.at(at("2026-03-01T00:00:01Z")).when(ChargePeriod, { planId: "p1", period: 1, version: 1 });
    expect(again.reason).toBe("ALREADY_CHARGED");
    expect(charges(s)).toEqual([[1, 900, "2026-02-28"]]);
  });

  test("cancelling ends the chain: the deadline already set fires, answers NOT_ACTIVE, and sets no other", async () => {
    const s = given();
    await s.at(anchor).when(StartPlan, { planId: "p1", amount: 900 });
    await s.at(at("2026-03-01T00:00:00Z")).fireDue(ChargePeriod);
    await s.at(at("2026-03-10T00:00:00Z")).when(CancelPlan, { planId: "p1" });
    expect((await s.at(at("2026-04-01T00:00:00Z")).fireDue(ChargePeriod)).map((f) => [f.outcome, f.reason])).toEqual([["noop", "NOT_ACTIVE"]]);
    expect(await s.at(at("2027-01-01T00:00:00Z")).fireDue(ChargePeriod)).toEqual([]); // nothing left
    expect(charges(s)).toEqual([[1, 900, "2026-02-28"]]);
  });

  test("a new price supersedes the deadline already set: it answers SUPERSEDED, and the new one charges the new price on the same calendar", async () => {
    const s = given();
    await s.at(anchor).when(StartPlan, { planId: "p1", amount: 900 });
    await s.at(at("2026-03-01T00:00:00Z")).fireDue(ChargePeriod);
    await s.at(at("2026-03-10T00:00:00Z")).when(ChangePlan, { planId: "p1", amount: 1200 });
    const fired = await s.at(at("2026-04-01T00:00:00Z")).fireDue(ChargePeriod);
    // Both deadlines of period 2 are due; they fire in due order, the old one first (it was set first).
    expect(fired.map((f) => [f.outcome, f.reason])).toEqual([["noop", "SUPERSEDED"], ["appended", null]]);
    expect(charges(s)).toEqual([[1, 900, "2026-02-28"], [2, 1200, "2026-03-31"]]);
  });

  test("periods missed while nothing fired are caught up: one firing each, each setting the next, until the plan is current", async () => {
    const s = given();
    await s.at(anchor).when(StartPlan, { planId: "p1", amount: 900 });
    // Nothing fired from February to June. Each round is one poll of the processor: the overdue deadline fires and sets the next, already due.
    const later = at("2026-06-15T00:00:00Z");
    const rounds: Array<number> = [];
    for (let round = 0; round < 10; round++) {
      const fired = await s.at(later).fireDue(ChargePeriod);
      if (fired.length === 0) break;
      rounds.push(fired.length);
    }
    expect(rounds).toEqual([1, 1, 1, 1]); // periods 1 to 4 (due Feb 28, Mar 31, Apr 30, May 31); period 5 is due Jun 30
    expect(charges(s).map(([period]) => period)).toEqual([1, 2, 3, 4]);
  });
});
