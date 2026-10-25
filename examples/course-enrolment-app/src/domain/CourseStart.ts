// A course is confirmed once it has a teacher, a room and enough students: the example of the "aggregate events" guide
// (docs/guides/build/aggregate-events.md), the EIP Aggregator with the event log as its store.
import * as Schema from "effect/Schema";
import { byModel, defineCommand, defineEvent, defineModel, emit, noop } from "@crablet/commands/Domain";
// The events, not the rules: Enrolment.ts's DefineCourse sets the deadline of CancelUnreadyCourse below, so this module must not import it.
import { CourseCancelled, CourseDefined, StudentSubscribed, SubscriptionReleased } from "./enrolment.events.ts";
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
// How long a defined course waits for a teacher, a room and enough students before it is cancelled.
export const READINESS_DAYS = 14;

// #region model
// The aggregator's state: what has arrived for one course so far. It is a fold of events already in the log, so there is no store of
// partial groups to keep, clean up or migrate, and the order they arrive in does not matter.
export const CourseReadiness = defineModel({
  by: "course_id",
  initial: () => ({
    teacherId: null as string | null,
    room: null as string | null,
    studentIds: [] as ReadonlyArray<string>,
    status: "waiting" as "waiting" | "confirmed" | "cancelled"
  })
})
  .on(TeacherAssigned, (s, d) => ({ ...s, teacherId: d.teacherId }))
  .on(RoomBooked, (s, d) => ({ ...s, room: d.room }))
  .on(StudentSubscribed, (s, d) => ({ ...s, studentIds: [...s.studentIds, d.studentId] }))
  .on(SubscriptionReleased, (s, d) => ({ ...s, studentIds: s.studentIds.filter((id) => id !== d.studentId) }))
  .on(CourseConfirmed, (s) => ({ ...s, status: "confirmed" as const }))
  .on(CourseCancelled, (s) => ({ ...s, status: "cancelled" as const }))
  .ignores(CourseDefined, CoursePriced, SubscriptionPaid);

// What the group still lacks: what a cancellation publishes.
const missingOf = (s: { readonly teacherId: string | null; readonly room: string | null; readonly studentIds: ReadonlyArray<string> }) => [
  ...(s.teacherId === null ? ["teacher" as const] : []),
  ...(s.room === null ? ["room" as const] : []),
  ...(s.studentIds.length < MIN_STUDENTS_TO_START ? ["students" as const] : [])
];
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
    s.status === "confirmed"
      ? noop("ALREADY_CONFIRMED")
      : s.status === "cancelled"
        ? noop("CANCELLED")
        : s.teacherId === null || s.room === null || s.studentIds.length < MIN_STUDENTS_TO_START
          ? noop("WAITING")
          : emit(CourseConfirmed({ courseId: c.courseId, teacherId: s.teacherId, room: s.room, students: s.studentIds.length }))
});
// #endregion command

// #region expiry
// The Aggregator's expiry: what the deadline DefineCourse set asks once READINESS_DAYS have passed. A course confirmed in time answers CONFIRMED and
// nothing happens; one still waiting is cancelled, with what it lacked and the students it had, so every one of them gets the slot back in the same
// append (CourseCancelled is tagged with each). Its boundary is the readiness events, the same as ConfirmCourse's: a confirmation and a cancellation that
// race cannot both happen, and a student who subscribes meanwhile makes the cancellation re-run with that student in it.
export const CancelUnreadyCourse = defineCommand({
  name: "cancel_unready_course",
  input: Schema.Struct({ courseId: Schema.String }),
  model: (c) => CourseReadiness.of({ id: c.courseId }),
  idempotentBy: byModel(),
  decide: (s, c) =>
    s.status === "confirmed"
      ? noop("CONFIRMED")
      : s.status === "cancelled"
        ? noop("ALREADY_CANCELLED")
        : emit(CourseCancelled({ courseId: c.courseId, missing: missingOf(s), studentIds: s.studentIds }))
});
// #endregion expiry
