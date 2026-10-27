// Slice: the student stops the billing and leaves the course.
import * as Schema from "effect/Schema";
import { defineCommand, DomainError, emit, fail } from "@crablet/commands/Domain";
import { SubscriptionReleased } from "../../domain/enrolment.events.ts";
import { SubscriptionModel } from "../../domain/Payments.ts";
import { billedBy } from "./billing.ts";
import { BillingStopped } from "./monthly-fee.events.ts";

export class NotBilled extends DomainError("NotBilled", { fields: { billingId: Schema.String }, kind: "not_found" }) {}

// #region stop-billing
// There is no deadline to cancel: the release takes the subscription out of `billed`, so the series' pending deadlines fire and answer NOT_BILLED.
// BillingStopped records why the series ended. A repeat is recognised by it (the subscription alone would answer NotBilled to a retry).
export const StopMonthlyFee = defineCommand({
  name: "stop_monthly_fee",
  input: Schema.Struct({ billingId: Schema.String, courseId: Schema.String, studentId: Schema.String }),
  errors: [NotBilled],
  model: (c) => SubscriptionModel.of({ id: c.studentId, courseId: c.courseId }),
  idempotentBy: (c) => BillingStopped.where({ billing_id: c.billingId }),
  decide: (subscription, c) =>
    !billedBy(subscription, c.billingId)
      ? fail(new NotBilled({ billingId: c.billingId }))
      : emit(BillingStopped({ billingId: c.billingId }), SubscriptionReleased({ courseId: c.courseId, studentId: c.studentId }))
});
// #endregion stop-billing
