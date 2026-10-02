// The page's view of the course API: the three calls it makes, and what can go wrong with each.
//
// Everything about the wire format comes from the API definition the server serves (course-enrolment-app/CourseApi):
// the routes, the response Schemas, and the domain errors, whose `tag` and `fields` are exactly what a refusal's problem
// body carries. This file keeps no copy of any of it. It imports no foldkit, so tests and the end-to-end check can use it.
import { Effect, Schema } from "effect";
import { HttpApiClient } from "effect/http-api";
import {
  CommandCreatedResponse,
  CommandIdempotentResponse,
  CourseFull,
  CourseNotFound,
  COURSE_SEATS_VIEW,
  CourseResponse,
  StudentAtLimit,
  ViewWaitResult,
  makeCourseApi
} from "course-enrolment-app/CourseApi";

// PROBLEMS: what a call can fail with, as the page understands it.

export const Problem = Schema.Union([
  Schema.TaggedStruct("CourseNotFound", { courseId: Schema.String }),
  Schema.TaggedStruct("CourseFull", { courseId: Schema.String, capacity: Schema.Int }),
  Schema.TaggedStruct("StudentAtLimit", { studentId: Schema.String, limit: Schema.Int }),
  // The framework's own refusals: a 400 (the input did not parse) and a 409 (for example, a course that already exists).
  Schema.TaggedStruct("Rejected", { title: Schema.String, detail: Schema.String }),
  // The derived client checks a request against the API's own Schema BEFORE sending it, and checks the answer against the
  // response Schema; either failure is a SchemaError whose message names the field (`at ["capacity"]`). The server's own 400
  // only says "Invalid payload for command", so this is the more precise of the two.
  Schema.TaggedStruct("Mismatch", { detail: Schema.String }),
  // Not from the server: the page's reading of a "no such course" it just wrote itself (the seat map lags behind writes).
  Schema.TaggedStruct("NotInSeatMapYet", { courseId: Schema.String }),
  Schema.TaggedStruct("Unreachable", {})
]);
export type Problem = typeof Problem.Type

// The body of a domain error's problem, built from the error class itself (its `tag` and `fields` statics): no field is
// written twice. Extra members of the body (`type`, `title`, `status`, `detail`) are ignored.
const problemBodyOf = <Tag extends string, F extends Record<string, Schema.Top>>(error: { readonly tag: Tag; readonly fields: F }) =>
  Schema.Struct({ errorType: Schema.Literal(error.tag), fields: Schema.Struct(error.fields) });

const isCourseNotFound = Schema.is(problemBodyOf(CourseNotFound));
const isCourseFull = Schema.is(problemBodyOf(CourseFull));
const isStudentAtLimit = Schema.is(problemBodyOf(StudentAtLimit));
const isFrameworkProblem = Schema.is(Schema.Struct({ title: Schema.String, detail: Schema.String }));

export const problemFromError = (error: unknown): Problem => {
  if (isCourseNotFound(error)) return { _tag: "CourseNotFound", courseId: error.fields.courseId };
  if (isCourseFull(error)) return { _tag: "CourseFull", courseId: error.fields.courseId, capacity: error.fields.capacity };
  if (isStudentAtLimit(error)) return { _tag: "StudentAtLimit", studentId: error.fields.studentId, limit: error.fields.limit };
  if (isFrameworkProblem(error)) return { _tag: "Rejected", title: error.title, detail: error.detail };
  if (Schema.isSchemaError(error)) return { _tag: "Mismatch", detail: error.message };
  return { _tag: "Unreachable" };
};

// CALLS

// What a command answered: created, or "already done" (an idempotent repeat) with the reason; and, when the request
// asked to wait for a view (`?waitFor=`), whether that view had caught up with the write when the answer was sent.
export const CommandOutcome = Schema.Struct({
  status: Schema.Literals(["CREATED", "IDEMPOTENT"]),
  reason: Schema.NullOr(Schema.String),
  view: Schema.optionalKey(ViewWaitResult)
});
export type CommandOutcome = typeof CommandOutcome.Type
const decodeCommandResponse = Schema.decodeUnknownEffect(Schema.Union([CommandCreatedResponse, CommandIdempotentResponse]));

export const getCourse = (courseId: string) =>
  Effect.gen(function* () {
    const client = yield* HttpApiClient.make(makeCourseApi());
    return yield* client.courseQueries.getCourse({ params: { courseId } });
  });

// The command routes are generated per command from the commands the server registers, so the derived client types
// `client.commands.<anything>` as a function over `any` (the known gap: a typed command client would need the route names
// in the API type). The one cast lives here and is narrowed to the call's shape, so everything else stays typed; the
// response is decoded with the API's own Schema straight away.
type CommandCall = (request: { readonly payload: object; readonly query: object }) => Effect.Effect<unknown, unknown>;

export const runCommand = (name: "define_course" | "subscribe", payload: object, options: { readonly waitForView: boolean }) =>
  Effect.gen(function* () {
    const client = yield* HttpApiClient.make(makeCourseApi());
    const call = (client.commands as unknown as Record<string, CommandCall>)[`execute_${name}`]!;
    // `?waitFor=course-seats-view`: the answer is sent once that view has processed the write, so the read that follows is not stale
    const response = yield* call({ payload, query: options.waitForView ? { waitFor: COURSE_SEATS_VIEW } : {} });
    const decoded = yield* decodeCommandResponse(response);
    return {
      status: decoded.status,
      reason: decoded.reason,
      ...(decoded.view === undefined ? {} : { view: decoded.view })
    } satisfies CommandOutcome;
  });

export { CourseResponse };
