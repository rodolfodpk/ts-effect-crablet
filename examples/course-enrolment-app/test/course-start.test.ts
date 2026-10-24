// The course-start aggregator (src/domain/CourseStart.ts, the "aggregate events" guide): in memory, no Docker.
import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import type { StoredEvent } from "@crablet/eventstore";
import type { AppendEvent } from "@crablet/eventstore/AppendEvent";
import { assertAutomationIdempotent } from "@crablet/automations/testing/AutomationIdempotency";
import { assertRepeatHarmless, given } from "@crablet/commands/testing/Scenario";
import { applyInMemory, rowsOf } from "@crablet/views/ViewMemory";
import { CourseDefined, StudentSubscribed } from "../src/domain/Enrolment.ts";
import { ConfirmCourse, CourseConfirmed, RoomBooked, TeacherAssigned } from "../src/domain/CourseStart.ts";
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
