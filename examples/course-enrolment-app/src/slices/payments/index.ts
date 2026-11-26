// The payments slice: a course's price, a subscription paid once, an unpaid one released when its window closes, and a receipt per payment. The
// receipt automation is defined and tested here; the app does not run it yet.
import { ReleaseUnpaidSubscription } from "./Payments.ts";

export * from "./Payments.ts";
export * from "./ReceiptOnPaymentAutomation.ts";

// What the deadlines module runs for this slice (processes.ts): the release Subscribe sets.
export const paymentsDeadlineCommands = [ReleaseUnpaidSubscription] as const;
