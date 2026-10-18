// The PUBLIC part of the course-enrolment commands: their names, their input Schemas and the domain errors they can fail with.
// Nothing here knows how a decision is made, so this module can be imported by a browser (through CourseApi.ts) without
// receiving the rules. The rules - events, models and `decide` - are in Enrolment.ts, which builds each command from its contract.
// Keep server-only imports out of this file: examples/course-enrolment-app/test/browser-safe.test.ts fails if it reaches one.
import * as Schema from "effect/Schema";
import { defineContract } from "@crablet/commands/Contract";
import { DomainError } from "@crablet/commands/Errors";

// #region errors
export class CourseNotFound extends DomainError("CourseNotFound", {
  fields: { courseId: Schema.String },
  kind: "not_found"
}) {}
export class CourseFull extends DomainError("CourseFull", {
  fields: { courseId: Schema.String, capacity: Schema.Int },
  kind: "conflict"
}) {}
export class StudentAtLimit extends DomainError("StudentAtLimit", {
  fields: { studentId: Schema.String, limit: Schema.Int },
  kind: "conflict"
}) {}
// The id is taken by a course with a different capacity. Defining the same course again is not an error: it is "already defined".
export class CourseAlreadyDefined extends DomainError("CourseAlreadyDefined", {
  fields: { courseId: Schema.String, capacity: Schema.Int },
  kind: "conflict"
}) {}
// #endregion errors

// #region contracts
export const DefineCourseContract = defineContract({
  name: "define_course",
  input: Schema.Struct({ courseId: Schema.String, capacity: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)) }),
  errors: [CourseAlreadyDefined]
});

export const SubscribeContract = defineContract({
  name: "subscribe",
  input: Schema.Struct({ studentId: Schema.String, courseId: Schema.String }),
  errors: [CourseNotFound, CourseFull, StudentAtLimit]
});
// #endregion contracts
