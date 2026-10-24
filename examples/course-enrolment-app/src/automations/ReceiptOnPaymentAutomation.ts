import { defineAutomation } from "@crablet/automations/AutomationHandler";
import { SendReceipt, SubscriptionPaid } from "../domain/Payments.ts";

// #region automation
// One event, one command: a payment asks for its receipt. The handler only maps the event to the command's input; it reads nothing and decides nothing.
export const receiptOnPayment = defineAutomation("receipt-on-payment", SendReceipt).on(SubscriptionPaid, (d) => ({
  paymentId: d.paymentId,
  courseId: d.courseId,
  studentId: d.studentId,
  amount: d.amount
}));
// #endregion automation
