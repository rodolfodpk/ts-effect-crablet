// The course-enrolment domain's events (the rules are in Enrolment.ts). A module of its own, imported by Enrolment.ts and Payments.ts alike: the payments
// fold these events, and the enrolment rules may name a payment command, so neither of the two modules imports the other's events.
import * as Schema from "effect/Schema";
import { defineEvent, Instant } from "@crablet/commands/Domain";

// #region events
export const CourseDefined = defineEvent("CourseDefined", {
  schema: Schema.Struct({ courseId: Schema.String, capacity: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)) }),
  tags: (d) => ({ course_id: d.courseId })
});

// One fact, tagged with BOTH the student and the course it concerns. `subscribedAt` is the decision's `now`, so a rule about time reads the
// business time, not when the row was stored. Optional, because subscriptions stored before it have none.
export const StudentSubscribed = defineEvent("StudentSubscribed", {
  schema: Schema.Struct({ studentId: Schema.String, courseId: Schema.String, subscribedAt: Schema.optionalKey(Instant) }),
  tags: (d) => ({ student_id: d.studentId, course_id: d.courseId })
});

// A subscription given back (one left unpaid: src/domain/Payments.ts). Both models undo it, so the seat and the student's slot are free again.
export const SubscriptionReleased = defineEvent("SubscriptionReleased", {
  schema: Schema.Struct({ studentId: Schema.String, courseId: Schema.String }),
  tags: (d) => ({ student_id: d.studentId, course_id: d.courseId })
});
// #endregion events

// #region course-cancelled
// A course that was not ready in time (src/domain/CourseStart.ts, CancelUnreadyCourse). ONE fact about the course AND every student subscribed to it:
// tagged with each of them, so each student's model folds it and gives the slot back in the same append, with no command per student. What was
// missing is the part of the group that never arrived (the Aggregator's partial result).
export const CourseCancelled = defineEvent("CourseCancelled", {
  schema: Schema.Struct({
    courseId: Schema.String,
    missing: Schema.Array(Schema.Literals(["teacher", "room", "students"])),
    studentIds: Schema.Array(Schema.String)
  }),
  tags: (d) => ({ course_id: d.courseId, student_id: d.studentIds })
});
// #endregion course-cancelled
