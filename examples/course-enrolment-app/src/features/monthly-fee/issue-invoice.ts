// Slice: the deadline that repeats. Each run issues one invoice and sets the deadline of the next, and the one that releases this invoice if it is
// not paid. Nothing else runs it: start-billing.ts sets the first.
import { DateTime } from "effect";
import * as Schema from "effect/Schema";
import { all, byModel, deadline, defineCommand, emit, noop } from "@crablet/commands/Domain";
import type { AppendEvent } from "@crablet/eventstore/AppendEvent";
import { SubscriptionModel } from "../../domain/Payments.ts";
import { BillingModel, billedBy, INVOICE_DUE_DAYS, invoiceIdOf } from "./billing.ts";
import { InvoiceIssued } from "./monthly-fee.events.ts";
import { ReleaseOverdueInvoice } from "./release-overdue.ts";

const IssueInvoiceInput = Schema.Struct({ billingId: Schema.String, courseId: Schema.String, studentId: Schema.String, n: Schema.Int });

// #region issue-invoice
// When the n-th invoice is issued: from the billing's start, never from when the deadline fired. A run that fires late (the processor was down, or
// behind) does not push the series: the next deadline is still at its planned date, and a series that fell behind catches up by itself, one invoice
// per poll, because each next deadline is already due.
const issueDateOf = (startsAt: DateTime.Utc, every: number, n: number): DateTime.Utc => DateTime.add(startsAt, { days: (n - 1) * every });

// When it falls due: INVOICE_DUE_DAYS after its planned date, but never sooner than INVOICE_DUE_DAYS from now. An invoice issued late still gives the
// student those days to pay; without it, the invoices of a series that caught up would be born overdue, and the seat released before the student
// ever saw them.
const dueDateOf = (issueDate: DateTime.Utc, now: DateTime.Utc): DateTime.Utc =>
  DateTime.max(DateTime.add(issueDate, { days: INVOICE_DUE_DAYS }), DateTime.add(now, { days: INVOICE_DUE_DAYS }));

// The deadline of the next run. A function with its type written, so the command can name itself: its own type is not needed to type its decide.
const next = (input: typeof IssueInvoiceInput.Type, at: DateTime.Utc): AppendEvent => deadline(IssueInvoice, input, { at });

// The model answers a repeat (the same deadline fired twice: a crash between running it and recording it, or a zombie leader): the billing knows the
// invoices it issued. A series ends without a cancel: once the subscription is no longer billed by it (an overdue invoice released it, the student
// stopped, the course was cancelled, or the student subscribed again), its pending deadline fires and answers NOT_BILLED, and sets no other.
export const IssueInvoice = defineCommand({
  name: "issue_invoice",
  input: IssueInvoiceInput,
  model: (c) => all({ billing: BillingModel.of({ id: c.billingId }), subscription: SubscriptionModel.of({ id: c.studentId, courseId: c.courseId }) }),
  idempotentBy: byModel(),
  decide: ({ billing, subscription }, c, { now }) => {
    if (!billedBy(subscription, c.billingId) || billing.startsAt === null) return noop("NOT_BILLED");
    if (billing.lastIssued >= c.n) return noop("ALREADY_ISSUED");
    const dueAt = dueDateOf(issueDateOf(billing.startsAt, billing.every, c.n), now);
    return emit(
      InvoiceIssued({ billingId: c.billingId, invoiceId: invoiceIdOf(c.billingId, c.n), n: c.n, amount: billing.amount, dueAt }),
      next({ ...c, n: c.n + 1 }, issueDateOf(billing.startsAt, billing.every, c.n + 1)),
      deadline(ReleaseOverdueInvoice, c, { at: dueAt })
    );
  }
});
// #endregion issue-invoice
