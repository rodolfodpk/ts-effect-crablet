// Slice: a subscription is billed monthly instead of paid once. Sets the first deadline of the series (issue-invoice.ts).
import { DateTime } from "effect";
import * as Schema from "effect/Schema";
import { all, deadline, defineCommand, emit, fail, noop } from "@crablet/commands/Domain";
import { AlreadyPaid, CourseNotPriced, CoursePricing, NotSubscribed, PaymentWindowClosed, SubscriptionModel } from "../../domain/Payments.ts";
import { MONTHLY_FEE_PERIOD_DAYS } from "./billing.ts";
import { BillingStarted } from "./monthly-fee.events.ts";
import { IssueInvoice } from "./issue-invoice.ts";

// #region start-billing
// Chosen within the payment window, instead of paying once: the subscription is then billed, and the window's deadline answers BILLED_MONTHLY. Each
// invoice is the course's price when the billing started; a later price applies to billings started after it. The first invoice is issued by the
// series' own deadline, due now, so it comes one poll later and the issuing is in one place.
export const StartMonthlyFee = defineCommand({
  name: "start_monthly_fee",
  input: Schema.Struct({ billingId: Schema.String, courseId: Schema.String, studentId: Schema.String }),
  errors: [NotSubscribed, AlreadyPaid, PaymentWindowClosed, CourseNotPriced],
  model: (c) => all({ pricing: CoursePricing.of({ id: c.courseId }), subscription: SubscriptionModel.of({ id: c.studentId, courseId: c.courseId }) }),
  // The billing id is the client's: a retry of the same start is recognised by it.
  idempotentBy: (c) => BillingStarted.where({ billing_id: c.billingId }),
  decide: ({ pricing, subscription }, c, { now }) =>
    subscription.status === "none" || subscription.status === "released"
      ? fail(new NotSubscribed({ courseId: c.courseId, studentId: c.studentId }))
      : subscription.status === "paid"
        ? fail(new AlreadyPaid({ courseId: c.courseId, studentId: c.studentId }))
        : subscription.status === "billed"
          ? noop("ALREADY_BILLED")
          : subscription.windowClosesAt !== null && DateTime.isGreaterThanOrEqualTo(now, subscription.windowClosesAt)
            ? fail(new PaymentWindowClosed({ courseId: c.courseId, studentId: c.studentId, closedAt: subscription.windowClosesAt }))
            : pricing.price === null
              ? fail(new CourseNotPriced({ courseId: c.courseId }))
              : emit(
                  BillingStarted({ ...c, amount: pricing.price, every: MONTHLY_FEE_PERIOD_DAYS, startsAt: now }),
                  deadline(IssueInvoice, { ...c, n: 1 }, { at: now })
                )
});
// #endregion start-billing
