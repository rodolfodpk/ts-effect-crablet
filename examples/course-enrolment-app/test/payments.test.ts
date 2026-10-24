// Prices, payments and releases (src/domain/Payments.ts): in memory, no Docker.
import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import type { StoredEvent } from "@crablet/eventstore";
import type { AppendEvent } from "@crablet/eventstore/AppendEvent";
import { assertRepeatHarmless, given } from "@crablet/commands/testing/Scenario";
import { applyInMemory, rowsOf } from "@crablet/views/ViewMemory";
import { CourseDefined, CourseFull, CourseNotFound, StudentAtLimit, StudentSubscribed, Subscribe, SubscriptionReleased } from "../src/domain/Enrolment.ts";
import { assertAutomationIdempotent } from "@crablet/automations/testing/AutomationIdempotency";
import { AlreadyPaid, CourseNotPriced, CoursePriced, NotSubscribed, PAYMENT_WINDOW_DAYS, PaymentWindowClosed, PaySubscription, PriceCourse, ReleaseUnpaidSubscription, SendReceipt, SubscriptionPaid, WrongAmount } from "../src/domain/Payments.ts";
import { receiptOnPayment } from "../src/automations/ReceiptOnPaymentAutomation.ts";
import { CourseSeatsView, courseSeatsTable } from "../src/views/CourseSeatsViewProjector.ts";

const PAYMENT_WINDOW_MS = PAYMENT_WINDOW_DAYS * 24 * 60 * 60_000;

const math = (capacity = 30): ReadonlyArray<AppendEvent> => [CourseDefined({ courseId: "math", capacity }), CoursePriced({ courseId: "math", price: 12000 })];
const pay = (studentId: string, paymentId: string, amount = 12000) => ({ courseId: "math", studentId, paymentId, amount });

describe("price_course", () => {
  test("prices a defined course; the same price again is a repeat; a new price is appended", async () => {
    const s = given(CourseDefined({ courseId: "math", capacity: 30 }));
    expect((await s.when(PriceCourse, { courseId: "math", price: 12000 })).outcome).toBe("created");
    expect((await s.when(PriceCourse, { courseId: "math", price: 12000 })).reason).toBe("ALREADY_PRICED");
    expect((await s.when(PriceCourse, { courseId: "math", price: 9000 })).events.map((e) => e.data)).toEqual([{ courseId: "math", price: 9000 }]);
  });

  test("a course that is not defined cannot be priced", async () => {
    expect((await given().when(PriceCourse, { courseId: "ghost", price: 100 })).error).toBeInstanceOf(CourseNotFound);
  });
});

describe("pay_subscription", () => {
  test("a subscribed student pays the course's price", async () => {
    const result = await given(...math(), StudentSubscribed({ studentId: "ann", courseId: "math" })).when(PaySubscription, pay("ann", "p-1"));
    expect(result.events.map((e) => e.type)).toEqual(["SubscriptionPaid"]);
  });

  test("the same payment again is recognised by its id: already done, nothing appended", async () => {
    const s = given(...math(), StudentSubscribed({ studentId: "ann", courseId: "math" }));
    await s.when(PaySubscription, pay("ann", "p-1"));
    const again = await s.when(PaySubscription, pay("ann", "p-1"));
    expect(again.reason).toBe("DUPLICATE_OPERATION");
    expect(again.events).toEqual([]);
  });

  test("a second, different payment for a paid subscription is refused", async () => {
    const s = given(...math(), StudentSubscribed({ studentId: "ann", courseId: "math" }));
    await s.when(PaySubscription, pay("ann", "p-1"));
    expect((await s.when(PaySubscription, pay("ann", "p-2"))).error).toBeInstanceOf(AlreadyPaid);
  });

  test("refused: not subscribed, released, not priced, or the wrong amount", async () => {
    expect((await given(...math()).when(PaySubscription, pay("ann", "p-1"))).error).toBeInstanceOf(NotSubscribed);
    const released = given(...math(), StudentSubscribed({ studentId: "ann", courseId: "math" }), SubscriptionReleased({ studentId: "ann", courseId: "math" }));
    expect((await released.when(PaySubscription, pay("ann", "p-1"))).error).toBeInstanceOf(NotSubscribed);
    const unpriced = given(CourseDefined({ courseId: "math", capacity: 30 }), StudentSubscribed({ studentId: "ann", courseId: "math" }));
    expect((await unpriced.when(PaySubscription, pay("ann", "p-1"))).error).toBeInstanceOf(CourseNotPriced);
    const wrong = await given(...math(), StudentSubscribed({ studentId: "ann", courseId: "math" })).when(PaySubscription, pay("ann", "p-1", 100));
    expect(wrong.error).toBeInstanceOf(WrongAmount);
    expect(wrong.error).toMatchObject({ expected: 12000, given: 100 });
  });

  test("a subscription to another course is not this one: the model is narrowed to the course", async () => {
    const s = given(...math(), CourseDefined({ courseId: "art", capacity: 30 }), StudentSubscribed({ studentId: "ann", courseId: "art" }));
    expect((await s.when(PaySubscription, pay("ann", "p-1"))).error).toBeInstanceOf(NotSubscribed);
  });
});

describe("release_unpaid_subscription", () => {
  // #region release-frees-a-seat
  test("releasing an unpaid subscription frees its seat: a full course takes another student", async () => {
    const s = given(...math(1), StudentSubscribed({ studentId: "ann", courseId: "math" }));
    expect((await s.when(Subscribe, { studentId: "bob", courseId: "math" })).error).toBeInstanceOf(CourseFull);
    expect((await s.when(ReleaseUnpaidSubscription, { courseId: "math", studentId: "ann" })).events.map((e) => e.type)).toEqual(["SubscriptionReleased"]);
    expect((await s.when(Subscribe, { studentId: "bob", courseId: "math" })).outcome).toBe("created");
  });
  // #endregion release-frees-a-seat

  test("a paid subscription is not released; neither is one that does not exist; a release is done once", async () => {
    const s = given(...math(), StudentSubscribed({ studentId: "ann", courseId: "math" }), SubscriptionPaid({ courseId: "math", studentId: "ann", paymentId: "p-1", amount: 12000 }));
    expect((await s.when(ReleaseUnpaidSubscription, { courseId: "math", studentId: "ann" })).reason).toBe("PAID");
    expect((await s.when(ReleaseUnpaidSubscription, { courseId: "math", studentId: "bob" })).reason).toBe("NOT_SUBSCRIBED");
    await assertRepeatHarmless(ReleaseUnpaidSubscription, { courseId: "math", studentId: "ann" }, [...math(), StudentSubscribed({ studentId: "ann", courseId: "math" })]);
  });

  test("a released student gets the slot back for the three-course limit, and can subscribe again", async () => {
    const s = given(...["a", "b", "c", "d"].map((courseId) => CourseDefined({ courseId, capacity: 10 })));
    for (const courseId of ["a", "b", "c"]) await s.when(Subscribe, { studentId: "ann", courseId });
    expect((await s.when(Subscribe, { studentId: "ann", courseId: "d" })).error).toBeInstanceOf(StudentAtLimit);
    const later = s.at(new Date(Date.now() + PAYMENT_WINDOW_MS + 60_000)); // the subscriptions were made with the real clock; past their window
    await later.when(ReleaseUnpaidSubscription, { courseId: "a", studentId: "ann" });
    expect((await later.when(Subscribe, { studentId: "ann", courseId: "d" })).outcome).toBe("created");
    expect((await later.when(Subscribe, { studentId: "ann", courseId: "a" })).error).toBeInstanceOf(StudentAtLimit);
  });

  test("the seats view takes a released seat back", async () => {
    let position = 0n;
    const stored = (e: AppendEvent): StoredEvent => ({
      eventId: crypto.randomUUID(), type: e.type, tags: e.tags, data: e.eventData, transactionId: "1", position: ++position, occurredAt: new Date(), correlationId: null, causationId: null
    });
    const events = [CourseDefined({ courseId: "math", capacity: 2 }), StudentSubscribed({ studentId: "ann", courseId: "math" }), StudentSubscribed({ studentId: "bob", courseId: "math" }), SubscriptionReleased({ studentId: "ann", courseId: "math" })];
    const db = await Effect.runPromise(applyInMemory(CourseSeatsView, events.map(stored)));
    expect(rowsOf(db, courseSeatsTable)).toEqual([{ course_id: "math", capacity: 2, subscribers: 1 }]);
  });
});

describe("the payment window: three days from the subscription", () => {
  const t0 = new Date("2026-11-02T09:00:00.000Z");
  const at = (ms: number) => new Date(t0.getTime() + ms);

  // #region payment-window-test
  test("a payment inside the window is taken; one after it is refused, whether or not the seat was released yet", async () => {
    const s = given(...math()).at(t0);
    await s.when(Subscribe, { studentId: "ann", courseId: "math" });
    await s.when(Subscribe, { studentId: "bob", courseId: "math" });

    expect((await s.at(at(PAYMENT_WINDOW_MS - 1)).when(PaySubscription, pay("ann", "p-1"))).outcome).toBe("created");
    const late = await s.at(at(PAYMENT_WINDOW_MS)).when(PaySubscription, pay("bob", "p-2"));
    expect(late.error).toBeInstanceOf(PaymentWindowClosed);
    expect(late.error).toMatchObject({ closedAt: at(PAYMENT_WINDOW_MS).toISOString() });
  });
  // #endregion payment-window-test

  test("an unpaid subscription is released only once its window has closed", async () => {
    const s = given(...math()).at(t0);
    await s.when(Subscribe, { studentId: "ann", courseId: "math" });
    expect((await s.at(at(PAYMENT_WINDOW_MS - 1)).when(ReleaseUnpaidSubscription, { courseId: "math", studentId: "ann" })).reason).toBe("WINDOW_OPEN");
    expect((await s.at(at(PAYMENT_WINDOW_MS)).when(ReleaseUnpaidSubscription, { courseId: "math", studentId: "ann" })).events.map((e) => e.type)).toEqual(["SubscriptionReleased"]);
  });

  test("the window starts from the decision's now, recorded on the event", async () => {
    const s = given(...math()).at(t0);
    const result = await s.when(Subscribe, { studentId: "ann", courseId: "math" });
    expect(result.events.map((e) => e.data)).toEqual([{ studentId: "ann", courseId: "math", subscribedAt: t0.toISOString() }]);
  });

  test("a subscription stored before subscribedAt existed has no window: it can be paid, and released, at any time", async () => {
    const s = given(...math(), StudentSubscribed({ studentId: "ann", courseId: "math" })).at(at(30 * PAYMENT_WINDOW_MS));
    expect((await s.when(PaySubscription, pay("ann", "p-1"))).outcome).toBe("created");
  });
});

describe("the receipt", () => {
  // #region receipt-test
  test("each payment gets one receipt, and a redelivered payment gets none more", async () => {
    const report = await assertAutomationIdempotent(receiptOnPayment, [
      SubscriptionPaid({ courseId: "math", studentId: "ann", paymentId: "p-1", amount: 12000 }),
      SubscriptionPaid({ courseId: "math", studentId: "bob", paymentId: "p-2", amount: 12000 })
    ]);
    expect(report.effects).toBe(2);
  });
  // #endregion receipt-test

  test("the receipt carries the payment and the time it was sent", async () => {
    const t0 = new Date("2026-11-02T09:00:00.000Z");
    const result = await given().at(t0).when(SendReceipt, { paymentId: "p-1", courseId: "math", studentId: "ann", amount: 12000 });
    expect(result.events.map((e) => e.data)).toEqual([{ paymentId: "p-1", courseId: "math", studentId: "ann", amount: 12000, sentAt: t0.toISOString() }]);
  });
});

describe("each command's repeat appends nothing", () => {
  test("price, pay and the receipt (release: above)", async () => {
    await assertRepeatHarmless(PriceCourse, { courseId: "math", price: 12000 }, [CourseDefined({ courseId: "math", capacity: 30 })]);
    await assertRepeatHarmless(PaySubscription, pay("ann", "p-1"), [...math(), StudentSubscribed({ studentId: "ann", courseId: "math" })]);
    await assertRepeatHarmless(SendReceipt, { paymentId: "p-1", courseId: "math", studentId: "ann", amount: 12000 });
  });
});
