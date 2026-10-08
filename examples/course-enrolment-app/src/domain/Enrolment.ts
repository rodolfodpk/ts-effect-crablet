// The course-enrolment domain of the tutorial (docs/tutorial/). Two rules, two kinds of
// entity, ONE decision:
//   - a course holds at most `capacity` students,
//   - a student takes at most 3 courses.
// No aggregate owns "subscribe": one event, `StudentSubscribed`, is tagged with BOTH the student and the course.
import * as Schema from "effect/Schema";
import { defineCommand, emit, fail, noop } from "@crablet/commands/Command";
import { CourseFull, CourseNotFound, DefineCourseContract, StudentAtLimit, SubscribeContract } from "./enrolment.contract.ts";
import { defineEvent } from "@crablet/commands/Event";
import { all, defineModel } from "@crablet/commands/Model";

// #region events
export const CourseDefined = defineEvent("CourseDefined", {
  schema: Schema.Struct({ courseId: Schema.String, capacity: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)) }),
  tags: (d) => ({ course_id: d.courseId })
});

// One fact, tagged with BOTH the student and the course it concerns.
export const StudentSubscribed = defineEvent("StudentSubscribed", {
  schema: Schema.Struct({ studentId: Schema.String, courseId: Schema.String }),
  tags: (d) => ({ student_id: d.studentId, course_id: d.courseId })
});
// #endregion events

export const MAX_COURSES_PER_STUDENT = 3;

// #region models
// Two models over the SAME events, looked at from two sides.
export const CourseModel = defineModel({
  by: "course_id",
  initial: () => ({ exists: false, capacity: 0, subscribers: 0 })
})
  .on(CourseDefined, (c, d) => ({ ...c, exists: true, capacity: d.capacity }))
  .on(StudentSubscribed, (c) => ({ ...c, subscribers: c.subscribers + 1 }));

export const StudentModel = defineModel({ by: "student_id", initial: () => ({ courses: [] as ReadonlyArray<string> }) })
  .on(StudentSubscribed, (s, d) => ({ courses: [...s.courses, d.courseId] }));
// #endregion models

// The errors and the public contracts are in enrolment.contract.ts (so a browser can import them without the rules below); re-exported for the server code.
export { CourseFull, CourseNotFound, StudentAtLimit } from "./enrolment.contract.ts";
export { DefineCourseContract, SubscribeContract } from "./enrolment.contract.ts";

// #region define-course
export const DefineCourse = defineCommand({
  ...DefineCourseContract,
  // defining the same course twice is a conflict, not a silent no-op
  idempotentBy: (c) => CourseDefined.where({ course_id: c.courseId }),
  onDuplicate: "fail",
  decide: (_, c) => emit(CourseDefined(c))
});
// #endregion define-course

// #region subscribe
export const Subscribe = defineCommand({
  ...SubscribeContract,
  // The boundary is the union of the course's events and the student's events.
  model: (c) => all({ course: CourseModel.of({ id: c.courseId }), student: StudentModel.of({ id: c.studentId }) }),
  decide: ({ course, student }, c) =>
    !course.exists
      ? fail(new CourseNotFound({ courseId: c.courseId }))
      : student.courses.includes(c.courseId)
        ? noop("ALREADY_SUBSCRIBED")
        : course.subscribers >= course.capacity
          ? fail(new CourseFull({ courseId: c.courseId, capacity: course.capacity }))
          : student.courses.length >= MAX_COURSES_PER_STUDENT
            ? fail(new StudentAtLimit({ studentId: c.studentId, limit: MAX_COURSES_PER_STUDENT }))
            : emit(StudentSubscribed(c))
});
// #endregion subscribe
