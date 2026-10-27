// Slice: a student pays one invoice.
import { DateTime } from "effect";
import * as Schema from "effect/Schema";
import { defineCommand, DomainError, emit, fail, Instant } from "@crablet/commands/Domain";
import { WrongAmount } from "../../domain/Payments.ts";
import { InvoiceModel, invoiceIdOf } from "./billing.ts";
import { InvoicePaid } from "./monthly-fee.events.ts";

export class InvoiceNotFound extends DomainError("InvoiceNotFound", { fields: { invoiceId: Schema.String }, kind: "not_found" }) {}
export class InvoiceAlreadyPaid extends DomainError("InvoiceAlreadyPaid", { fields: { invoiceId: Schema.String }, kind: "conflict" }) {}
export class InvoicePastDue extends DomainError("InvoicePastDue", { fields: { invoiceId: Schema.String, dueAt: Instant }, kind: "conflict" }) {}

// #region pay-invoice
// Its boundary is this one invoice, the narrowest there is: paying invoice n does not conflict with issuing invoice n+1 or with paying another one.
// The due date is checked against `now`, as a one-off payment's window is (Payments.ts); a release that raced it is caught by the boundary instead
// (release-overdue.ts), so the two cannot both happen.
export const PayInvoice = defineCommand({
  name: "pay_invoice",
  input: Schema.Struct({ billingId: Schema.String, n: Schema.Int, paymentId: Schema.String, amount: Schema.Int }),
  errors: [InvoiceNotFound, InvoiceAlreadyPaid, InvoicePastDue, WrongAmount],
  model: (c) => InvoiceModel.of({ id: invoiceIdOf(c.billingId, c.n) }),
  // A payment can be retried, and the invoice's state cannot tell the retry from a second payment: the payment id does.
  idempotentBy: (c) => InvoicePaid.where({ payment_id: c.paymentId }),
  decide: (invoice, c, { now }) => {
    const invoiceId = invoiceIdOf(c.billingId, c.n);
    return !invoice.issued || invoice.dueAt === null
      ? fail(new InvoiceNotFound({ invoiceId }))
      : invoice.paid
        ? fail(new InvoiceAlreadyPaid({ invoiceId }))
        : invoice.overdue || DateTime.isGreaterThanOrEqualTo(now, invoice.dueAt)
          ? fail(new InvoicePastDue({ invoiceId, dueAt: invoice.dueAt }))
          : c.amount !== invoice.amount
            ? fail(new WrongAmount({ expected: invoice.amount, given: c.amount }))
            : emit(InvoicePaid({ billingId: c.billingId, invoiceId, n: c.n, paymentId: c.paymentId, amount: c.amount }));
  }
});
// #endregion pay-invoice
