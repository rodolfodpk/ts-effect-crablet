// A course is confirmed once it has a teacher, a room and enough students: the example of the "aggregate events" guide
// (docs/guides/build/aggregate-events.md), the EIP Aggregator with the event log as its store.
import * as Schema from "effect/Schema";
import { byModel, defineCommand, defineEvent, defineModel, emit, noop } from "@crablet/commands/Domain";
import { CourseDefined, StudentSubscribed, SubscriptionReleased } from "./Enrolment.ts";
import { CoursePriced, SubscriptionPaid } from "./Payments.ts";

// #region events
// Facts that arrive in any order, from different commands, about one course: the `course_id` tag correlates them. The third kind is
// StudentSubscribed (Enrolment.ts), counted until the course has enough students.
export const TeacherAssigned = defineEvent("TeacherAssigned", {
  schema: Schema.Struct({ courseId: Schema.String, teacherId: Schema.String }),
  tags: (d) => ({ course_id: d.courseId })
});
export const RoomBooked = defineEvent("RoomBooked", {
  schema: Schema.Struct({ courseId: Schema.String, room: Schema.String }),
  tags: (d) => ({ course_id: d.courseId })
});

// What is published once all of them are there: the aggregate.
export const CourseConfirmed = defineEvent("CourseConfirmed", {
  schema: Schema.Struct({ courseId: Schema.String, teacherId: Schema.String, room: Schema.String, students: Schema.Int }),
  tags: (d) => ({ course_id: d.courseId })
});
// #endregion events

export const MIN_STUDENTS_TO_START = 3;

// #region model
// The aggregator's state: what has arrived for one course so far. It is a fold of events already in the log, so there is no store of
// partial groups to keep, clean up or migrate, and the order they arrive in does not matter.
export const CourseReadiness = defineModel({
  by: "course_id",
  initial: () => ({ teacherId: null as string | null, room: null as string | null, students: 0, confirmed: false })
})
  .on(TeacherAssigned, (s, d) => ({ ...s, teacherId: d.teacherId }))
  .on(RoomBooked, (s, d) => ({ ...s, room: d.room }))
  .on(StudentSubscribed, (s) => ({ ...s, students: s.students + 1 }))
  .on(SubscriptionReleased, (s) => ({ ...s, students: s.students - 1 }))
  .on(CourseConfirmed, (s) => ({ ...s, confirmed: true }))
  .ignores(CourseDefined, CoursePriced, SubscriptionPaid);
// #endregion model

// #region command
// The completeness condition and the aggregation: once everything is there, one CourseConfirmed; until then, nothing.
// Its boundary is the course's readiness events, so two runs that race append one CourseConfirmed: the second conflicts, re-runs and sees it.
export const ConfirmCourse = defineCommand({
  name: "confirm_course",
  input: Schema.Struct({ courseId: Schema.String }),
  model: (c) => CourseReadiness.of({ id: c.courseId }),
  idempotentBy: byModel(), // the model shows whether it was done; decide answers a repeat
  decide: (s, c) =>
    s.confirmed
      ? noop("ALREADY_CONFIRMED")
      : s.teacherId === null || s.room === null || s.students < MIN_STUDENTS_TO_START
        ? noop("WAITING")
        : emit(CourseConfirmed({ courseId: c.courseId, teacherId: s.teacherId, room: s.room, students: s.students }))
});
// #endregion command
