// The monthly fee: a subscription billed every MONTHLY_FEE_PERIOD_DAYS instead of paid once, a deadline that repeats (ADR-0043). One file per slice;
// the slices share the events (monthly-fee.events.ts) and billing.ts, and the rest of the app sees BillingStarted only (Payments.ts folds it).
export * from "./monthly-fee.events.ts";
export { BillingModel, INVOICE_DUE_DAYS, InvoiceModel, invoiceIdOf, MONTHLY_FEE_PERIOD_DAYS } from "./billing.ts";
export { StartMonthlyFee } from "./start-billing.ts";
export { IssueInvoice } from "./issue-invoice.ts";
export { InvoiceAlreadyPaid, InvoiceNotFound, InvoicePastDue, PayInvoice } from "./pay-invoice.ts";
export { ReleaseOverdueInvoice } from "./release-overdue.ts";
export { NotBilled, StopMonthlyFee } from "./stop-billing.ts";

import { IssueInvoice } from "./issue-invoice.ts";
import { ReleaseOverdueInvoice } from "./release-overdue.ts";

// What the deadlines processor runs for this feature: the app spreads it into its list (CourseApp.ts), so a new deadline here is registered here.
export const monthlyFeeDeadlineCommands = [IssueInvoice, ReleaseOverdueInvoice] as const;
