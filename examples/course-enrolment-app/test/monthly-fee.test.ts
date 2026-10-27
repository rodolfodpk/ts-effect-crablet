// The monthly fee (src/features/monthly-fee): a deadline that repeats (ADR-0043). In memory, no Docker; the deadlines are fired with `fireDue`.
import { describe, expect, test } from "bun:test";
import { DateTime } from "effect";
import type { AppendEvent } from "@crablet/eventstore/AppendEvent";
import { given, type Scenario } from "@crablet/commands/testing/Scenario";
import { CourseCancelled, CourseDefined, Subscribe } from "../src/domain/Enrolment.ts";
import { AlreadyPaid, BilledMonthly, CoursePriced, NotSubscribed, PaymentWindowClosed, PaySubscription, ReleaseUnpaidSubscription } from "../src/domain/Payments.ts";
import {
  InvoiceAlreadyPaid,
  InvoiceNotFound,
  InvoicePastDue,
  IssueInvoice,
  monthlyFeeDeadlineCommands,
  NotBilled,
  PayInvoice,
  StartMonthlyFee,
  StopMonthlyFee
} from "../src/features/monthly-fee/index.ts";
import { SubscriptionModel, WrongAmount } from "../src/domain/Payments.ts";
import { queryMatches } from "@crablet/eventstore/spec/Spec";
import { all } from "@crablet/commands/Domain";
import { InvoiceModel, invoiceIdOf } from "../src/features/monthly-fee/billing.ts";

const PRICE = 12000;
const t0 = DateTime.makeUnsafe("2026-11-02T09:00:00.000Z");
const day = (n: number) => DateTime.add(t0, { days: n });
const iso = (t: DateTime.Utc) => DateTime.formatIso(t);
const math = (): ReadonlyArray<AppendEvent> => [CourseDefined({ courseId: "math", capacity: 30 }), CoursePriced({ courseId: "math", price: PRICE })];
const ann = { courseId: "math", studentId: "ann" };

// What the deadlines processor is given: the payment window's release (Subscribe sets it) and the monthly fee's own.
const deadlineCommands = [ReleaseUnpaidSubscription, ...monthlyFeeDeadlineCommands];

// `fireDue` fires what was due when it was called, not the deadlines that firing sets (the next invoice, already due when a series is behind): the
// processor finds those on its next poll. This does the polls until nothing is due.
const fireAll = async (s: Scenario) => {
  const fired = [];
  for (;;) {
    const round = await s.fireDue(...deadlineCommands);
    if (round.length === 0) return fired;
    fired.push(...round);
  }
};

// Ann subscribes at t0 and starts billing `b` (the series starts then: day 0).
const billed = async (billingId = "b-1") => {
  const s = given(...math());
  await s.at(t0).when(Subscribe, ann);
  expect((await s.at(t0).when(StartMonthlyFee, { billingId, ...ann })).outcome).toBe("created");
  return s;
};

const invoices = (s: Scenario) =>
  s.log.filter((e) => e.type === "InvoiceIssued").map((e) => e.data as { billingId: string; n: number; amount: number; dueAt: string });
const scheduled = (s: Scenario, command: string) =>
  s.log
    .filter((e) => e.type === "crablet.DeadlineScheduled" && (e.data as { command: string }).command === command)
    .map((e) => e.data as { input: { billingId: string; n: number }; dueAt: string });
// The firings of the monthly fee's deadlines only: Subscribe's payment window fires too, and its answer is tested in Payments.
const ofFee = (fired: ReadonlyArray<{ readonly command: string }>) => fired.filter((f) => f.command !== "release_unpaid_subscription");
const pay = (n: number, paymentId: string, amount = PRICE, billingId = "b-1") => ({ billingId, n, paymentId, amount });

describe("issue_invoice: the deadline that repeats", () => {
  test("starting the billing issues invoice 1 at once; invoice 2 at day 30, 3 at day 60, each due 10 days later", async () => {
    const s = await billed();
    await fireAll(s.at(t0));
    expect(invoices(s).map((i) => [i.n, i.amount, i.dueAt])).toEqual([[1, PRICE, iso(day(10))]]);
    await s.at(day(5)).when(PayInvoice, pay(1, "p-1"));

    expect(await fireAll(s.at(day(29)))).toMatchObject([{ command: "release_unpaid_subscription", reason: "BILLED_MONTHLY" }, { command: "release_overdue_invoice", reason: "PAID" }]);
    await fireAll(s.at(day(30)));
    await s.at(day(31)).when(PayInvoice, pay(2, "p-2"));
    await fireAll(s.at(day(60)));
    expect(invoices(s).map((i) => [i.n, i.dueAt])).toEqual([[1, iso(day(10))], [2, iso(day(40))], [3, iso(day(70))]]);
  });

  test("a run that fires late does not push the series: invoice 2 fired on day 33 still sets invoice 3 for day 60", async () => {
    const s = await billed();
    await fireAll(s.at(t0));
    await s.at(day(1)).when(PayInvoice, pay(1, "p-1"));
    await fireAll(s.at(day(33)));
    expect(scheduled(s, "issue_invoice").map((d) => [d.input.n, d.dueAt])).toEqual([[1, iso(t0)], [2, iso(day(30))], [3, iso(day(60))]]);
  });

  test("a series that fell behind catches up by itself, and every late invoice still gets its 10 days", async () => {
    const s = await billed();
    await fireAll(s.at(t0));
    await s.at(day(1)).when(PayInvoice, pay(1, "p-1"));
    // The processor was down from day 1 to day 95: invoices 2 (day 30), 3 (day 60) and 4 (day 90) are issued now, each due on day 105, not born overdue.
    await fireAll(s.at(day(95)));
    expect(invoices(s).map((i) => [i.n, i.dueAt])).toEqual([[1, iso(day(10))], [2, iso(day(105))], [3, iso(day(105))], [4, iso(day(105))]]);
    expect(scheduled(s, "issue_invoice").at(-1)).toMatchObject({ input: { n: 5 }, dueAt: iso(day(120)) });
  });

  test("the same deadline fired twice issues one invoice: the billing knows what it issued", async () => {
    const s = await billed();
    await fireAll(s.at(t0));
    const again = await s.at(t0).when(IssueInvoice, { billingId: "b-1", ...ann, n: 1 });
    expect(again.reason).toBe("ALREADY_ISSUED");
    expect(invoices(s)).toHaveLength(1);
  });
});

describe("release_overdue_invoice", () => {
  test("an invoice not paid by its due date releases the seat, and the series ends: its next deadline answers NOT_BILLED and sets none", async () => {
    const s = await billed();
    await fireAll(s.at(t0));
    const fired = await fireAll(s.at(day(10)));
    expect(fired.find((f) => f.command === "release_overdue_invoice")!.events.map((e) => e.type)).toEqual(["InvoiceOverdue", "SubscriptionReleased"]);
    expect(ofFee(await fireAll(s.at(day(30))))).toMatchObject([{ command: "issue_invoice", reason: "NOT_BILLED" }]);
    expect(scheduled(s, "issue_invoice")).toHaveLength(2);
  });

  test("a paid invoice is not released", async () => {
    const s = await billed();
    await fireAll(s.at(t0));
    await s.at(day(9)).when(PayInvoice, pay(1, "p-1"));
    expect(ofFee(await fireAll(s.at(day(10))))).toMatchObject([{ command: "release_overdue_invoice", reason: "PAID" }]);
  });
});

describe("pay_invoice", () => {
  test("refused: an invoice not issued, already paid, past its due date, or the wrong amount; the same payment again is a repeat", async () => {
    const s = await billed();
    expect((await s.at(t0).when(PayInvoice, pay(1, "p-1"))).error).toBeInstanceOf(InvoiceNotFound);
    await fireAll(s.at(t0));
    const wrong = await s.at(day(1)).when(PayInvoice, pay(1, "p-1", 100));
    expect(wrong.error).toBeInstanceOf(WrongAmount);
    expect(wrong.error).toMatchObject({ expected: PRICE, given: 100 });
    expect((await s.at(day(1)).when(PayInvoice, pay(1, "p-1"))).outcome).toBe("created");
    expect((await s.at(day(2)).when(PayInvoice, pay(1, "p-1"))).reason).toBe("DUPLICATE_OPERATION");
    expect((await s.at(day(2)).when(PayInvoice, pay(1, "p-2"))).error).toBeInstanceOf(InvoiceAlreadyPaid);
    await fireAll(s.at(day(30)));
    expect((await s.at(day(40)).when(PayInvoice, pay(2, "p-3"))).error).toBeInstanceOf(InvoicePastDue);
  });

  test("an invoice released for being overdue cannot be paid, whatever the clock says", async () => {
    const s = await billed();
    await fireAll(s.at(t0));
    await fireAll(s.at(day(10)));
    // A pod whose clock is behind still sees the release: it is in the invoice's events.
    expect((await s.at(day(9)).when(PayInvoice, pay(1, "p-1"))).error).toBeInstanceOf(InvoicePastDue);
  });
});

describe("stop_monthly_fee", () => {
  test("stops the series and gives the seat back; the pending deadlines answer NOT_BILLED; a repeat is recognised", async () => {
    const s = await billed();
    await fireAll(s.at(t0));
    await s.at(day(1)).when(PayInvoice, pay(1, "p-1"));
    const stop = await s.at(day(2)).when(StopMonthlyFee, { billingId: "b-1", ...ann });
    expect(stop.events.map((e) => e.type)).toEqual(["BillingStopped", "SubscriptionReleased"]);
    expect((await s.at(day(3)).when(StopMonthlyFee, { billingId: "b-1", ...ann })).reason).toBe("DUPLICATE_OPERATION");
    expect(ofFee(await fireAll(s.at(day(30))))).toMatchObject([{ command: "release_overdue_invoice", reason: "PAID" }, { command: "issue_invoice", reason: "NOT_BILLED" }]);
    expect((await s.at(day(31)).when(StopMonthlyFee, { billingId: "b-9", ...ann })).error).toBeInstanceOf(NotBilled);
  });

  test("a cancelled course ends its billings the same way", async () => {
    const s = await billed();
    await fireAll(s.at(t0));
    await s.at(day(1)).when(PayInvoice, pay(1, "p-1"));
    s.store.seed(CourseCancelled({ courseId: "math", missing: ["room"], studentIds: ["ann"] }));
    expect(ofFee(await fireAll(s.at(day(30))))).toMatchObject([{ command: "release_overdue_invoice", reason: "PAID" }, { command: "issue_invoice", reason: "NOT_BILLED" }]);
  });
});

describe("start_monthly_fee", () => {
  test("a student released and subscribed again starts a new series; the old one's deadlines cannot touch it", async () => {
    const s = await billed("b-1");
    await fireAll(s.at(t0));
    await fireAll(s.at(day(10))); // invoice 1 overdue: released
    await s.at(day(11)).when(Subscribe, ann);
    await s.at(day(11)).when(StartMonthlyFee, { billingId: "b-2", ...ann });
    const fired = await fireAll(s.at(day(30)));
    // An invoice names its billing; a deadline names it in its command's input.
    const billingOf = (data: unknown) => (data as { billingId?: string; input?: { billingId: string } }).billingId ?? (data as { input: { billingId: string } }).input.billingId;
    expect(fired.filter((f) => f.command === "issue_invoice").map((f) => [f.reason, f.events.map((e) => billingOf(e.data))])).toEqual([
      [null, ["b-2", "b-2", "b-2"]], // b-2's invoice 1 (due at once): the invoice and its two deadlines
      ["NOT_BILLED", []] // b-1's invoice 2
    ]);
  });

  test("a billed subscription is not paid once, nor released by the payment window", async () => {
    const s = await billed();
    expect((await s.at(day(1)).when(PaySubscription, { ...ann, paymentId: "p-1", amount: PRICE })).error).toBeInstanceOf(BilledMonthly);
    expect((await s.at(day(3)).when(ReleaseUnpaidSubscription, ann)).reason).toBe("BILLED_MONTHLY");
  });

  test("refused: not subscribed, paid once, or after the payment window; started again is a repeat or already billed", async () => {
    expect((await given(...math()).at(t0).when(StartMonthlyFee, { billingId: "b-1", ...ann })).error).toBeInstanceOf(NotSubscribed);

    const paid = given(...math());
    await paid.at(t0).when(Subscribe, ann);
    await paid.at(t0).when(PaySubscription, { ...ann, paymentId: "p-1", amount: PRICE });
    expect((await paid.at(t0).when(StartMonthlyFee, { billingId: "b-1", ...ann })).error).toBeInstanceOf(AlreadyPaid);

    const late = given(...math());
    await late.at(t0).when(Subscribe, ann);
    expect((await late.at(day(3)).when(StartMonthlyFee, { billingId: "b-1", ...ann })).error).toBeInstanceOf(PaymentWindowClosed);

    const s = await billed();
    expect((await s.at(t0).when(StartMonthlyFee, { billingId: "b-1", ...ann })).reason).toBe("DUPLICATE_OPERATION");
    expect((await s.at(t0).when(StartMonthlyFee, { billingId: "b-2", ...ann })).reason).toBe("ALREADY_BILLED");
  });
});

// Two decisions conflict when one's boundary (its model's query) matches an event the other appends: the rule the conditional append checks
// (eventstore's spec). Checked on the events the commands really append.
describe("the slices' boundaries", () => {
  const invoice = (n: number) => InvoiceModel.of({ id: invoiceIdOf("b-1", n) });
  const overdueRelease = (n: number) => all({ invoice: invoice(n), subscription: SubscriptionModel.of({ id: "ann", courseId: "math" }) });

  test("paying invoice n does not conflict with issuing invoice n+1; it does with releasing invoice n, both ways", async () => {
    const s = await billed();
    await fireAll(s.at(t0));
    await s.at(day(1)).when(PayInvoice, pay(1, "p-1"));
    const issued = (await fireAll(s.at(day(30)))).find((f) => f.command === "issue_invoice")!.events; // invoice 2 and its two deadlines
    expect(issued).toHaveLength(3);
    expect(issued.some((e) => queryMatches(invoice(1).query, e))).toBe(false); // what PayInvoice(1) reads: untouched

    const released = (await fireAll(s.at(day(40)))).find((f) => f.command === "release_overdue_invoice")!.events; // invoice 2, not paid
    expect(released.map((e) => e.type)).toEqual(["InvoiceOverdue", "SubscriptionReleased"]);
    expect(released.some((e) => queryMatches(invoice(2).query, e))).toBe(true); // a PayInvoice(2) racing the release conflicts

    const t = await billed();
    await fireAll(t.at(t0));
    const paid = (await t.at(day(1)).when(PayInvoice, pay(1, "p-1"))).events;
    expect(paid.some((e) => queryMatches(overdueRelease(1).query, e))).toBe(true); // and the release racing the payment conflicts too
  });
});
