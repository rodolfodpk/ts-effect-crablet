// The monthly fee's events: the contract between its slices (one file per slice in this folder), and the one thing the rest of the app sees of it.
// A module of its own, like domain/enrolment.events.ts: domain/Payments.ts folds BillingStarted, and the slices read Payments.ts's subscription
// model, so neither imports the other's rules.
//
// Tagged with the billing (and the invoice), not the course and the student, so no model of the rest of the app has to account for them. The one
// exception is BillingStarted: whether a subscription is paid once or billed monthly is a rule of the subscription (Payments.ts), so it is tagged
// with the course and the student too.
import * as Schema from "effect/Schema";
import { defineEvent, Instant } from "@crablet/commands/Domain";

// #region events
// A subscription is billed every `every` days from `startsAt`, `amount` each time, until it is released. The billing id is the client's (as a payment
// id is), so a student who is released, subscribes again and is billed again starts a new series, which the old one's deadlines cannot touch.
export const BillingStarted = defineEvent("BillingStarted", {
  schema: Schema.Struct({ billingId: Schema.String, courseId: Schema.String, studentId: Schema.String, amount: Schema.Int, every: Schema.Int, startsAt: Instant }),
  tags: (d) => ({ billing_id: d.billingId, course_id: d.courseId, student_id: d.studentId })
});

// The n-th invoice of a billing, payable until `dueAt`.
export const InvoiceIssued = defineEvent("InvoiceIssued", {
  schema: Schema.Struct({ billingId: Schema.String, invoiceId: Schema.String, n: Schema.Int, amount: Schema.Int, dueAt: Instant }),
  tags: (d) => ({ billing_id: d.billingId, invoice_id: d.invoiceId })
});

// Tagged with the payment too, so a repeat of the same payment is recognised by its id.
export const InvoicePaid = defineEvent("InvoicePaid", {
  schema: Schema.Struct({ billingId: Schema.String, invoiceId: Schema.String, n: Schema.Int, paymentId: Schema.String, amount: Schema.Int }),
  tags: (d) => ({ billing_id: d.billingId, invoice_id: d.invoiceId, payment_id: d.paymentId })
});

// An invoice not paid by its due date. Tagged with the invoice, so a payment and the release that race over it conflict (release-overdue.ts).
export const InvoiceOverdue = defineEvent("InvoiceOverdue", {
  schema: Schema.Struct({ billingId: Schema.String, invoiceId: Schema.String, n: Schema.Int }),
  tags: (d) => ({ billing_id: d.billingId, invoice_id: d.invoiceId })
});

// The student stopped the billing (and left the course): why the series ended, when it did not end by an overdue invoice.
export const BillingStopped = defineEvent("BillingStopped", {
  schema: Schema.Struct({ billingId: Schema.String }),
  tags: (d) => ({ billing_id: d.billingId })
});
// #endregion events
