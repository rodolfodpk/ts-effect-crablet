// Slice: an invoice not paid by its due date gives the seat back. Run by the deadline issue-invoice.ts sets at the due date.
import * as Schema from "effect/Schema";
import { all, byModel, defineCommand, emit, noop } from "@crablet/commands/Domain";
import { SubscriptionReleased } from "../../domain/enrolment.events.ts";
import { SubscriptionModel } from "../../domain/Payments.ts";
import { billedBy, InvoiceModel, invoiceIdOf } from "./billing.ts";
import { InvoiceOverdue } from "./monthly-fee.events.ts";

// #region release-overdue
// Its boundary is the invoice's events (and the subscription's): a payment and this release that race over the invoice cannot both happen, whatever the
// two pods' clocks say. InvoiceOverdue is tagged with the invoice, so a payment that read before it conflicts and re-runs, and sees it. The release is
// the enrolment's own SubscriptionReleased, so the seat and the student's slot are free again, and every later deadline of the series answers
// NOT_BILLED.
export const ReleaseOverdueInvoice = defineCommand({
  name: "release_overdue_invoice",
  input: Schema.Struct({ billingId: Schema.String, courseId: Schema.String, studentId: Schema.String, n: Schema.Int }),
  model: (c) =>
    all({ invoice: InvoiceModel.of({ id: invoiceIdOf(c.billingId, c.n) }), subscription: SubscriptionModel.of({ id: c.studentId, courseId: c.courseId }) }),
  idempotentBy: byModel(),
  decide: ({ invoice, subscription }, c) =>
    invoice.paid
      ? noop("PAID")
      : !billedBy(subscription, c.billingId)
        ? noop("NOT_BILLED")
        : emit(
            InvoiceOverdue({ billingId: c.billingId, invoiceId: invoiceIdOf(c.billingId, c.n), n: c.n }),
            SubscriptionReleased({ courseId: c.courseId, studentId: c.studentId })
          )
});
// #endregion release-overdue
