// The course-start aggregator (src/domain/CourseStart.ts, the "aggregate events" guide): in memory, no Docker.
import { describe, expect, test } from "bun:test";
import { DateTime, Effect } from "effect";
import type { StoredEvent } from "@crablet/eventstore";
import type { AppendEvent } from "@crablet/eventstore/AppendEvent";
import { assertAutomationIdempotent } from "@crablet/automations/testing/AutomationIdempotency";
import { assertRepeatHarmless, given } from "@crablet/commands/testing/Scenario";
import { applyInMemory, rowsOf } from "@crablet/views/ViewMemory";
import { CourseCancelled, CourseDefined, CourseWasCancelled, DefineCourse, StudentSubscribed, Subscribe, SubscriptionReleased } from "../src/domain/Enrolment.ts";
import { CoursePriced, NotSubscribed, PaySubscription, ReleaseUnpaidSubscription } from "../src/domain/Payments.ts";
import { CourseSeatsView, courseSeatsTable } from "../src/views/CourseSeatsViewProjector.ts";
import { CancelUnreadyCourse, ConfirmCourse, CourseConfirmed, READINESS_DAYS, RoomBooked, TeacherAssigned } from "../src/domain/CourseStart.ts";
import { confirmCourseWhenReady } from "../src/automations/ConfirmCourseAutomation.ts";
import { CourseReadinessView, courseReadinessTable } from "../src/views/CourseReadinessViewProjector.ts";

const parts = (courseId: string): ReadonlyArray<AppendEvent> => [
  TeacherAssigned({ courseId, teacherId: "t-1" }),
  RoomBooked({ courseId, room: "r-101" }),
  ...["ann", "bob", "cy"].map((studentId) => StudentSubscribed({ studentId, courseId }))
];

// Every order the five events of a course can arrive in.
const orders = <A,>(items: ReadonlyArray<A>): ReadonlyArray<ReadonlyArray<A>> =>
  items.length <= 1 ? [items] : items.flatMap((first, i) => orders([...items.slice(0, i), ...items.slice(i + 1)]).map((rest) => [first, ...rest]));

describe("confirm_course: the completeness condition", () => {
  // #region any-order-test
  test("in every order the events can arrive in, it waits until the last one, then confirms once", async () => {
    for (const order of orders(parts("math"))) {
      for (let arrived = 1; arrived <= order.length; arrived++) {
        const result = await given(CourseDefined({ courseId: "math", capacity: 30 }), ...order.slice(0, arrived)).when(ConfirmCourse, { courseId: "math" });
        if (arrived < order.length) expect(result.reason).toBe("WAITING");
        else expect(result.events.map((e) => e.type)).toEqual(["CourseConfirmed"]);
      }
    }
  });
  // #endregion any-order-test

  test("what it publishes is the aggregate: the teacher, the room and the number of students", async () => {
    const result = await given(...parts("math")).when(ConfirmCourse, { courseId: "math" });
    expect(result.events.map((e) => e.data)).toEqual([{ courseId: "math", teacherId: "t-1", room: "r-101", students: 3 }]);
  });

  test("once confirmed, asking again is ALREADY_CONFIRMED, and a repeat appends nothing", async () => {
    const s = given(...parts("math"));
    await s.when(ConfirmCourse, { courseId: "math" });
    const again = await s.when(ConfirmCourse, { courseId: "math" });
    expect(again.reason).toBe("ALREADY_CONFIRMED");
    expect(again.events).toEqual([]);
    await assertRepeatHarmless(ConfirmCourse, { courseId: "math" }, parts("math"));
  });

  test("a released subscription no longer counts: back to waiting", async () => {
    const result = await given(...parts("math"), SubscriptionReleased({ studentId: "cy", courseId: "math" })).when(ConfirmCourse, { courseId: "math" });
    expect(result.reason).toBe("WAITING");
  });

  test("another course's events are not this course's: the tag correlates them", async () => {
    const result = await given(...parts("art").slice(0, 2), ...parts("math").slice(2)).when(ConfirmCourse, { courseId: "math" });
    expect(result.reason).toBe("WAITING");
  });
});

describe("the automation that asks it", () => {
  // #region automation-test
  test("each course is confirmed once, however many of its events wake the automation, and a redelivery does nothing", async () => {
    // Ten triggers, two courses: two confirmations. The log is ahead of the deliveries, so the first trigger of a course may already see all of it.
    const report = await assertAutomationIdempotent(confirmCourseWhenReady, [...parts("math"), ...parts("art")]);
    expect(report.effects).toBe(2);
  });
  // #endregion automation-test
});

describe("the readiness view", () => {
  let position = 0n;
  const stored = (e: AppendEvent): StoredEvent => ({
    eventId: crypto.randomUUID(),
    type: e.type,
    tags: e.tags,
    data: e.eventData,
    transactionId: "1",
    position: ++position,
    occurredAt: new Date(),
    correlationId: null,
    causationId: null
  });

  test("the rows are the same in every order the events are delivered in", async () => {
    const events = [...parts("math"), CourseConfirmed({ courseId: "math", teacherId: "t-1", room: "r-101", students: 3 })];
    for (const order of orders(events)) {
      const db = await Effect.runPromise(applyInMemory(CourseReadinessView, order.map(stored)));
      expect(rowsOf(db, courseReadinessTable)).toEqual([{ course_id: "math", teacher_id: "t-1", room: "r-101", students: 3, status: "confirmed" }]);
    }
  });

  test("a course with something missing shows what it is", async () => {
    const db = await Effect.runPromise(applyInMemory(CourseReadinessView, parts("math").slice(1).map(stored)));
    expect(rowsOf(db, courseReadinessTable)).toEqual([{ course_id: "math", teacher_id: null, room: "r-101", students: 3, status: "waiting" }]);
  });
});

describe("the expiry: a course not ready in time is cancelled (a deadline DefineCourse sets)", () => {
  const t0 = DateTime.makeUnsafe("2026-11-02T09:00:00.000Z");
  const daysLater = (days: number) => DateTime.add(t0, { days });

  // #region expiry-test
  test("at the deadline a course still waiting is cancelled with what it lacked; its students get their slot back and it takes no more", async () => {
    const s = given(CoursePriced({ courseId: "math", price: 100 }), TeacherAssigned({ courseId: "math", teacherId: "t-1" })).at(t0);
    await s.when(DefineCourse, { courseId: "math", capacity: 30 });
    for (const studentId of ["ann", "bob"]) {
      await s.when(Subscribe, { studentId, courseId: "math" });
      await s.when(PaySubscription, { courseId: "math", studentId, paymentId: `p-${studentId}`, amount: 100 });
    }

    // Day 14: the payment deadlines (day 3) answer that the seats are paid; the readiness deadline cancels the course, still without a room.
    const fired = await s.at(daysLater(READINESS_DAYS)).fireDue(CancelUnreadyCourse, ReleaseUnpaidSubscription);
    expect(fired.map((f) => [f.command, f.outcome, f.reason])).toEqual([
      ["release_unpaid_subscription", "noop", "PAID"],
      ["release_unpaid_subscription", "noop", "PAID"],
      ["cancel_unready_course", "appended", null]
    ]);
    const cancelled = fired[2]!.events[0]!;
    expect(cancelled.data).toEqual({ courseId: "math", missing: ["room", "students"], studentIds: ["ann", "bob"] });
    expect(cancelled.tags.map((t) => `${t.key}=${t.value}`)).toEqual(["course_id=math", "student_id=ann", "student_id=bob"]);

    const after = s.at(daysLater(READINESS_DAYS + 1));
    expect((await after.when(Subscribe, { studentId: "cy", courseId: "math" })).error).toBeInstanceOf(CourseWasCancelled);
    expect((await after.when(ConfirmCourse, { courseId: "math" })).reason).toBe("CANCELLED");
    // ann's slot in the three-course limit is free again: three other courses are allowed.
    for (const courseId of ["a", "b", "c"]) {
      await after.when(DefineCourse, { courseId, capacity: 5 });
      expect((await after.when(Subscribe, { studentId: "ann", courseId })).outcome).toBe("created");
    }
  });
  // #endregion expiry-test

  test("a course confirmed in time answers CONFIRMED at its deadline, and nothing is cancelled", async () => {
    const s = given(...parts("math")).at(t0);
    await s.when(DefineCourse, { courseId: "math", capacity: 30 });
    await s.when(ConfirmCourse, { courseId: "math" });
    const fired = await s.at(daysLater(READINESS_DAYS)).fireDue(CancelUnreadyCourse);
    expect(fired.map((f) => [f.outcome, f.reason])).toEqual([["noop", "CONFIRMED"]]);
  });

  test("a payment for a cancelled course is refused: the subscription ended with it", async () => {
    const s = given(CoursePriced({ courseId: "math", price: 100 })).at(t0);
    await s.when(DefineCourse, { courseId: "math", capacity: 30 });
    await s.when(Subscribe, { studentId: "ann", courseId: "math" });
    await s.at(daysLater(1)).when(CancelUnreadyCourse, { courseId: "math" }); // as the deadline would, early
    const pay = await s.at(daysLater(2)).when(PaySubscription, { courseId: "math", studentId: "ann", paymentId: "p-1", amount: 100 });
    expect(pay.error).toBeInstanceOf(NotSubscribed);
  });

  test("the views follow the cancellation: no seat taken, status cancelled (the enrolments view, raw SQL: course-enrolments-view.test.ts)", async () => {
    let position = 0n;
    const stored = (e: AppendEvent): StoredEvent => ({
      eventId: crypto.randomUUID(), type: e.type, tags: e.tags, data: e.eventData, transactionId: "1", position: ++position, occurredAt: new Date(), correlationId: null, causationId: null
    });
    const events = [
      CourseDefined({ courseId: "math", capacity: 30 }),
      StudentSubscribed({ studentId: "ann", courseId: "math" }),
      StudentSubscribed({ studentId: "bob", courseId: "math" }),
      CourseCancelled({ courseId: "math", missing: ["teacher", "room", "students"], studentIds: ["ann", "bob"] })
    ].map(stored);
    const readiness = await Effect.runPromise(applyInMemory(CourseReadinessView, events));
    expect(rowsOf(readiness, courseReadinessTable)).toMatchObject([{ course_id: "math", status: "cancelled" }]);
    const seats = await Effect.runPromise(applyInMemory(CourseSeatsView, events));
    expect(rowsOf(seats, courseSeatsTable)).toEqual([{ course_id: "math", capacity: 30, subscribers: 0 }]);
  });
});
