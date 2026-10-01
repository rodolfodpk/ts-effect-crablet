// The DCB guide's second example (docs/dcb-guide.md): course enrolment, a rule no single aggregate owns.
// Shared by enrolment-guide.test.ts (in-memory) and integration/enrolment-guide-postgres.test.ts.
// The code between the markers is what the guide shows.
import { Effect } from "effect";
import * as Schema from "effect/Schema";
import { defineCommand, emit, fail, noop } from "../../src/Command.ts";
import { DomainError } from "../../src/Errors.ts";
import { defineEvent } from "../../src/Event.ts";
import { all, defineModel } from "../../src/Model.ts";
import { afterLoad } from "./barrier.ts";

// ---- START GUIDE ----
export const CourseDefined = defineEvent("CourseDefined", {
  schema: Schema.Struct({ courseId: Schema.String, capacity: Schema.Number }),
  tags: (d) => ({ course_id: d.courseId })
});
// One fact, tagged with BOTH the student and the course it concerns.
export const StudentSubscribed = defineEvent("StudentSubscribed", {
  schema: Schema.Struct({ studentId: Schema.String, courseId: Schema.String }),
  tags: (d) => ({ student_id: d.studentId, course_id: d.courseId })
});

export const MAX_COURSES_PER_STUDENT = 3;

// Two models over the SAME events, looked at from two sides.
export const CourseModel = defineModel({
  by: "course_id",
  initial: () => ({ exists: false, capacity: 0, subscribers: 0 })
})
  .on(CourseDefined, (c, d) => ({ ...c, exists: true, capacity: d.capacity }))
  .on(StudentSubscribed, (c) => ({ ...c, subscribers: c.subscribers + 1 }));

export const StudentModel = defineModel({ by: "student_id", initial: () => ({ courses: [] as ReadonlyArray<string> }) })
  .on(StudentSubscribed, (s, d) => ({ courses: [...s.courses, d.courseId] }));

export class CourseNotFound extends DomainError("CourseNotFound", {
  fields: { courseId: Schema.String },
  kind: "not_found"
}) {}
export class CourseFull extends DomainError("CourseFull", {
  fields: { courseId: Schema.String, capacity: Schema.Number },
  kind: "conflict"
}) {}
export class StudentAtLimit extends DomainError("StudentAtLimit", {
  fields: { studentId: Schema.String, limit: Schema.Number },
  kind: "conflict"
}) {}

export const subscribeInput = Schema.Struct({ studentId: Schema.String, courseId: Schema.String });

type Course = { readonly exists: boolean; readonly capacity: number; readonly subscribers: number };
type Student = { readonly courses: ReadonlyArray<string> };

// Two rules, two different entities, ONE decision:
//   - a course holds at most `capacity` students,
//   - a student takes at most 3 courses.
const decide = ({ course, student }: { course: Course; student: Student }, c: { studentId: string; courseId: string }) =>
  !course.exists
    ? fail(new CourseNotFound({ courseId: c.courseId }))
    : student.courses.includes(c.courseId)
      ? noop("ALREADY_SUBSCRIBED")
      : course.subscribers >= course.capacity
        ? fail(new CourseFull({ courseId: c.courseId, capacity: course.capacity }))
        : student.courses.length >= MAX_COURSES_PER_STUDENT
          ? fail(new StudentAtLimit({ studentId: c.studentId, limit: MAX_COURSES_PER_STUDENT }))
          : emit(StudentSubscribed(c));

export const Subscribe = defineCommand({
  name: "subscribe",
  input: subscribeInput,
  // The boundary is the union of the course's events and the student's events.
  model: (c) => all({ course: CourseModel.of({ id: c.courseId }), student: StudentModel.of({ id: c.studentId }) }),
  decide
});
// ---- END GUIDE ----

// Test-only variant with a barrier after the model has loaded (see support/barrier.ts).
export const subscribeWith = (opts: { wait: Effect.Effect<void>; retries?: number }) =>
  defineCommand({
    name: "subscribe_raced",
    input: subscribeInput,
    model: (c) => afterLoad(all({ course: CourseModel.of({ id: c.courseId }), student: StudentModel.of({ id: c.studentId }) }), opts.wait),
    retries: opts.retries ?? 3,
    decide
  });
