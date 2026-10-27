// A course has a price, and a subscription is paid for; one left unpaid is released when its payment window closes, which frees its seat: `Subscribe`
// sets a deadline that runs the release then (docs/adr/0043-a-deadline-is-an-event-in-the-log.md).
import { DateTime } from "effect";
import * as Schema from "effect/Schema";
import { all, byModel, defineCommand, defineEvent, defineModel, DomainError, emit, fail, Instant, noop } from "@crablet/commands/Domain";
// The enrolment's events and errors, not its rules (Enrolment.ts): Enrolment.ts may import this module.
import { CourseCancelled, CourseDefined, StudentSubscribed, SubscriptionReleased } from "./enrolment.events.ts";
import { CourseNotFound } from "./enrolment.contract.ts";
// The one event of the monthly fee (src/features/monthly-fee) the subscription folds: a subscription is paid once, or billed monthly.
import { BillingStarted } from "../features/monthly-fee/monthly-fee.events.ts";

// #region events
// A price in cents. A separate event, not a field added to CourseDefined: stored CourseDefined events stay as they are.
export const CoursePriced = defineEvent("CoursePriced", {
  schema: Schema.Struct({ courseId: Schema.String, price: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)) }),
  tags: (d) => ({ course_id: d.courseId })
});

// Tagged with the payment too, so a repeat of the same payment is recognised by its id (`idempotentBy` below).
export const SubscriptionPaid = defineEvent("SubscriptionPaid", {
  schema: Schema.Struct({ courseId: Schema.String, studentId: Schema.String, paymentId: Schema.String, amount: Schema.Int }),
  tags: (d) => ({ course_id: d.courseId, student_id: d.studentId, payment_id: d.paymentId })
});

// A receipt is about one payment, so it is tagged with the payment alone: no course or student model has to account for it.
export const ReceiptSent = defineEvent("ReceiptSent", {
  schema: Schema.Struct({ paymentId: Schema.String, courseId: Schema.String, studentId: Schema.String, amount: Schema.Int, sentAt: Instant }),
  tags: (d) => ({ payment_id: d.paymentId })
});
// #endregion events

// How long a subscription can stay unpaid.
export const PAYMENT_WINDOW_DAYS = 3;

export class CourseNotPriced extends DomainError("CourseNotPriced", { fields: { courseId: Schema.String }, kind: "conflict" }) {}
export class NotSubscribed extends DomainError("NotSubscribed", { fields: { courseId: Schema.String, studentId: Schema.String }, kind: "not_found" }) {}
export class AlreadyPaid extends DomainError("AlreadyPaid", { fields: { courseId: Schema.String, studentId: Schema.String }, kind: "conflict" }) {}
export class WrongAmount extends DomainError("WrongAmount", { fields: { expected: Schema.Int, given: Schema.Int }, kind: "invalid" }) {}
export class BilledMonthly extends DomainError("BilledMonthly", { fields: { courseId: Schema.String, studentId: Schema.String }, kind: "conflict" }) {}
export class PaymentWindowClosed extends DomainError("PaymentWindowClosed", { fields: { courseId: Schema.String, studentId: Schema.String, closedAt: Instant }, kind: "conflict" }) {}

// #region models
// The course's price. It reads the course's definition and its prices only, so pricing a course does not conflict with its subscriptions.
export const CoursePricing = defineModel({ by: "course_id", initial: () => ({ exists: false, price: null as number | null }) })
  .on(CourseDefined, (p) => ({ ...p, exists: true }))
  .on(CoursePriced, (p, d) => ({ ...p, price: d.price }))
  .ignores(StudentSubscribed, SubscriptionReleased, SubscriptionPaid, CourseCancelled);

// One student's subscription to one course: the student's events, narrowed by `scope` to that course's. `windowClosesAt` is when the payment window
// closes, from the time the subscription recorded; null for a subscription stored before it recorded one, which has no window. A subscription is
// paid once (`paid`) or billed monthly (`billed`, by `billingId`: the monthly fee's slices check it is still their billing).
export const SubscriptionModel = defineModel({
  by: "student_id",
  initial: () => ({
    status: "none" as "none" | "subscribed" | "paid" | "billed" | "released",
    windowClosesAt: null as DateTime.Utc | null,
    billingId: null as string | null
  }),
  scope: (s: { courseId: string }) => ({ course_id: s.courseId })
})
  .on(StudentSubscribed, (_s, d) => ({
    status: "subscribed" as const,
    windowClosesAt: d.subscribedAt === undefined ? null : DateTime.add(d.subscribedAt, { days: PAYMENT_WINDOW_DAYS }),
    billingId: null
  }))
  .on(BillingStarted, (s, d) => ({ ...s, status: "billed" as const, billingId: d.billingId }))
  .on(SubscriptionPaid, (s) => ({ ...s, status: "paid" as const }))
  .on(SubscriptionReleased, (s) => ({ ...s, status: "released" as const }))
  // A cancelled course ends its subscriptions: none can be paid any more, and the payment deadline finds nothing to release. A paid one is owed a
  // refund, which this app does not model.
  .on(CourseCancelled, (s) => ({ ...s, status: "released" as const }));

const windowClosed = (s: { readonly windowClosesAt: DateTime.Utc | null }, now: DateTime.Utc): boolean =>
  s.windowClosesAt !== null && DateTime.isGreaterThanOrEqualTo(now, s.windowClosesAt);
// #endregion models

// #region price-course
export const PriceCourse = defineCommand({
  name: "price_course",
  input: Schema.Struct({ courseId: Schema.String, price: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)) }),
  errors: [CourseNotFound],
  model: (c) => CoursePricing.of({ id: c.courseId }),
  idempotentBy: byModel(),
  // A new price applies to the payments made from now on.
  decide: (p, c) => (!p.exists ? fail(new CourseNotFound({ courseId: c.courseId })) : p.price === c.price ? noop("ALREADY_PRICED") : emit(CoursePriced(c)))
});
// #endregion price-course

// #region pay
export const PaySubscription = defineCommand({
  name: "pay_subscription",
  input: Schema.Struct({ courseId: Schema.String, studentId: Schema.String, paymentId: Schema.String, amount: Schema.Int }),
  errors: [NotSubscribed, AlreadyPaid, BilledMonthly, PaymentWindowClosed, CourseNotPriced, WrongAmount],
  model: (c) => all({ pricing: CoursePricing.of({ id: c.courseId }), subscription: SubscriptionModel.of({ id: c.studentId, courseId: c.courseId }) }),
  // A payment can be retried, and the subscription's state cannot tell the retry from a second payment: the payment id does.
  idempotentBy: (c) => SubscriptionPaid.where({ payment_id: c.paymentId }),
  // The window is checked against `now` here, when the payment arrives: whether the subscription was released yet does not matter.
  decide: ({ pricing, subscription }, c, { now }) =>
    subscription.status === "none" || subscription.status === "released"
      ? fail(new NotSubscribed({ courseId: c.courseId, studentId: c.studentId }))
      : subscription.status === "paid"
        ? fail(new AlreadyPaid({ courseId: c.courseId, studentId: c.studentId }))
        : subscription.status === "billed"
          ? fail(new BilledMonthly({ courseId: c.courseId, studentId: c.studentId }))
          : windowClosed(subscription, now)
            ? fail(new PaymentWindowClosed({ courseId: c.courseId, studentId: c.studentId, closedAt: subscription.windowClosesAt! }))
            : pricing.price === null
              ? fail(new CourseNotPriced({ courseId: c.courseId }))
              : c.amount !== pricing.price
                ? fail(new WrongAmount({ expected: pricing.price, given: c.amount }))
                : emit(SubscriptionPaid(c))
});
// #endregion pay

// #region release
// Gives back a subscription that was not paid once its window has closed. Its boundary is the subscription's events, so a payment and a release that
// race cannot both happen: the second conflicts, re-runs, and sees the first. The deadline `Subscribe` sets runs it at the window's end; for a paid
// subscription it answers PAID, and that is all a deadline that no longer matters costs (there is no cancel). One billed monthly is not released here:
// an overdue invoice releases it (src/features/monthly-fee).
export const ReleaseUnpaidSubscription = defineCommand({
  name: "release_unpaid_subscription",
  input: Schema.Struct({ courseId: Schema.String, studentId: Schema.String }),
  model: (c) => SubscriptionModel.of({ id: c.studentId, courseId: c.courseId }),
  idempotentBy: byModel(),
  decide: (s, c, { now }) =>
    s.status === "none"
      ? noop("NOT_SUBSCRIBED")
      : s.status === "released"
        ? noop("ALREADY_RELEASED")
        : s.status === "paid"
          ? noop("PAID")
          : s.status === "billed"
            ? noop("BILLED_MONTHLY")
            : s.windowClosesAt !== null && !windowClosed(s, now)
              ? noop("WINDOW_OPEN")
              : emit(SubscriptionReleased(c))
});
// #endregion release

// #region receipt
// What the receipt automation issues for each payment. A payment's event can be delivered twice, so the receipt is recognised by the payment's id.
// The email itself is not sent here: an outbox topic publishing ReceiptSent sends it, at least once, with the event's id to deduplicate.
export const SendReceipt = defineCommand({
  name: "send_receipt",
  input: Schema.Struct({ paymentId: Schema.String, courseId: Schema.String, studentId: Schema.String, amount: Schema.Int }),
  idempotentBy: (c) => ReceiptSent.where({ payment_id: c.paymentId }),
  decide: (_, c, { now }) => emit(ReceiptSent({ ...c, sentAt: now }))
});
// #endregion receipt
