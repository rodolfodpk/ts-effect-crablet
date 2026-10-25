// The course-enrolment domain of the tutorial (docs/tutorial/). Two rules, two kinds of
// entity, ONE decision:
//   - a course holds at most `capacity` students,
//   - a student takes at most 3 courses.
// No aggregate owns "subscribe": one event, `StudentSubscribed`, is tagged with BOTH the student and the course.
import { DateTime } from "effect";
import { all, byModel, deadline, defineCommand, defineModel, emit, fail, noop } from "@crablet/commands/Domain";
import { CourseAlreadyDefined, CourseFull, CourseNotFound, CourseWasCancelled, DefineCourseContract, StudentAtLimit, SubscribeContract } from "./enrolment.contract.ts";
import { CourseCancelled, CourseDefined, StudentSubscribed, SubscriptionReleased } from "./enrolment.events.ts";
import { CancelUnreadyCourse, READINESS_DAYS } from "./CourseStart.ts";
import { PAYMENT_WINDOW_DAYS, ReleaseUnpaidSubscription } from "./Payments.ts";

// The events are in enrolment.events.ts, so the payments (src/domain/Payments.ts) can read them without importing these rules, and these rules can
// name a payment command (a deadline, ADR-0043) without an import cycle. Re-exported for the rest of the app.
export { CourseCancelled, CourseDefined, StudentSubscribed, SubscriptionReleased } from "./enrolment.events.ts";

export const MAX_COURSES_PER_STUDENT = 3;

// #region models
// Two models over the SAME events, looked at from two sides.
export const CourseModel = defineModel({
  by: "course_id",
  initial: () => ({ exists: false, cancelled: false, capacity: 0, subscribers: 0 })
})
  .on(CourseDefined, (c, d) => ({ ...c, exists: true, capacity: d.capacity }))
  .on(StudentSubscribed, (c) => ({ ...c, subscribers: c.subscribers + 1 }))
  .on(SubscriptionReleased, (c) => ({ ...c, subscribers: c.subscribers - 1 }))
  .on(CourseCancelled, (c) => ({ ...c, cancelled: true, subscribers: 0 }));

export const StudentModel = defineModel({ by: "student_id", initial: () => ({ courses: [] as ReadonlyArray<string> }) })
  .on(StudentSubscribed, (s, d) => ({ courses: [...s.courses, d.courseId] }))
  .on(SubscriptionReleased, (s, d) => ({ courses: s.courses.filter((c) => c !== d.courseId) }))
  // A cancelled course gives every student it was tagged with the slot back.
  .on(CourseCancelled, (s, d) => ({ courses: s.courses.filter((c) => c !== d.courseId) }));
// #endregion models

// The errors and the public contracts are in enrolment.contract.ts (so a browser can import them without the rules below); re-exported for the server code.
export { CourseAlreadyDefined, CourseFull, CourseNotFound, CourseWasCancelled, StudentAtLimit } from "./enrolment.contract.ts";
export { DefineCourseContract, SubscribeContract } from "./enrolment.contract.ts";

// #region define-course
export const DefineCourse = defineCommand({
  ...DefineCourseContract,
  // The same course again is a retry ("already defined"); another course under the same id is a conflict.
  model: (c) => CourseModel.of({ id: c.courseId }),
  idempotentBy: byModel(), // the model shows whether it was done; decide answers a repeat
  decide: (course, c, { now }) =>
    !course.exists
      ? emit(
          CourseDefined(c),
          // The course waits READINESS_DAYS for a teacher, a room and enough students; then CancelUnreadyCourse decides (CourseStart.ts).
          deadline(CancelUnreadyCourse, { courseId: c.courseId }, { at: DateTime.add(now, { days: READINESS_DAYS }) })
        )
      : course.capacity === c.capacity
        ? noop("ALREADY_DEFINED")
        : fail(new CourseAlreadyDefined({ courseId: c.courseId, capacity: course.capacity }))
});
// #endregion define-course

// #region subscribe
export const Subscribe = defineCommand({
  ...SubscribeContract,
  // The boundary is the union of the course's events and the student's events.
  model: (c) => all({ course: CourseModel.of({ id: c.courseId }), student: StudentModel.of({ id: c.studentId }) }),
  idempotentBy: byModel(), // the model shows whether it was done; decide answers a repeat
  decide: ({ course, student }, c, { now }) =>
    !course.exists
      ? fail(new CourseNotFound({ courseId: c.courseId }))
      : course.cancelled
        ? fail(new CourseWasCancelled({ courseId: c.courseId }))
        : student.courses.includes(c.courseId)
          ? noop("ALREADY_SUBSCRIBED")
          : course.subscribers >= course.capacity
            ? fail(new CourseFull({ courseId: c.courseId, capacity: course.capacity }))
            : student.courses.length >= MAX_COURSES_PER_STUDENT
              ? fail(new StudentAtLimit({ studentId: c.studentId, limit: MAX_COURSES_PER_STUDENT }))
              : emit(
                  StudentSubscribed({ ...c, subscribedAt: now }),
                  // When the payment window closes, the deadlines processor asks for the seat back; a paid subscription answers that it is paid.
                  deadline(ReleaseUnpaidSubscription, { courseId: c.courseId, studentId: c.studentId }, { at: DateTime.add(now, { days: PAYMENT_WINDOW_DAYS }) })
                )
});
// #endregion subscribe
