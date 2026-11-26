// What the monthly fee's slices share, and nothing outside this folder uses: the period, the ids and the two models.
import { DateTime } from "effect";
import { defineModel } from "@crablet/commands/Domain";
import { BillingStarted, BillingStopped, InvoiceIssued, InvoiceOverdue, InvoicePaid } from "./monthly-fee.events.ts";

// How often a billed subscription is invoiced, and how long each invoice stays payable.
export const MONTHLY_FEE_PERIOD_DAYS = 30;
export const INVOICE_DUE_DAYS = 10;

export const invoiceIdOf = (billingId: string, n: number): string => `${billingId}#${n}`;

// #region models
// One billing: its plan, and how many invoices it has issued. The issuing slice's model; its boundary is the billing's own events, so paying an
// invoice (InvoicePaid) does not conflict with issuing the next one.
export const BillingModel = defineModel({
  by: "billing_id",
  initial: () => ({ started: false, amount: 0, every: 0, startsAt: null as DateTime.Utc | null, lastIssued: 0 })
})
  .on(BillingStarted, (b, d) => ({ ...b, started: true, amount: d.amount, every: d.every, startsAt: d.startsAt }))
  .on(InvoiceIssued, (b, d) => ({ ...b, lastIssued: Math.max(b.lastIssued, d.n) }))
  .ignores(InvoicePaid, InvoiceOverdue, BillingStopped);

// One invoice: the narrowest boundary there is. Paying it and releasing it for being overdue both read and append this invoice's events, so the two
// cannot both happen: the second conflicts, re-runs, and sees the first.
export const InvoiceModel = defineModel({
  by: "invoice_id",
  initial: () => ({ issued: false, amount: 0, dueAt: null as DateTime.Utc | null, paid: false, overdue: false })
})
  .on(InvoiceIssued, (i, d) => ({ ...i, issued: true, amount: d.amount, dueAt: d.dueAt }))
  .on(InvoicePaid, (i) => ({ ...i, paid: true }))
  .on(InvoiceOverdue, (i) => ({ ...i, overdue: true }));
// #endregion models

// Whether the subscription is billed by THIS billing: not released (overdue, stopped, the course cancelled) and not subscribed again since. Every
// deadline of the series asks it first, so a series ends without a cancel: its pending deadlines fire and answer NOT_BILLED.
export const billedBy = (subscription: { readonly status: string; readonly billingId: string | null }, billingId: string): boolean =>
  subscription.status === "billed" && subscription.billingId === billingId;
