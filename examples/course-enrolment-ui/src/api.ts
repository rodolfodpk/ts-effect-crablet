// The page's view of the course API: the calls it makes, and what can go wrong with each.
//
// Everything about the wire format comes from the API definition the server serves (course-enrolment-app/CourseApi):
// the routes, the request and response Schemas, and for every command the exact set of problems it can answer with. The
// derived client is typed per command from that definition, so this file keeps no copy of any of it and needs no cast.
// It imports no foldkit, so tests and the end-to-end check can use it.
import { Effect, Schema } from "effect";
import { HttpApiClient } from "effect/http-api";
import { COURSE_SEATS_VIEW, CourseResponse, ViewWaitResult, makeCourseApi } from "course-enrolment-app/CourseApi";

// What a command answered: created, or "already done" (an idempotent repeat) with the reason; and, when the request
// asked to wait for a view (`?waitFor=`), whether that view had caught up with the write when the answer was sent.
export const CommandOutcome = Schema.Struct({
  status: Schema.Literals(["CREATED", "IDEMPOTENT"]),
  reason: Schema.NullOr(Schema.String),
  view: Schema.optionalKey(ViewWaitResult)
});
export type CommandOutcome = typeof CommandOutcome.Type

// #region call
// `?waitFor=course-seats-view`: the answer is sent once that view has processed the write, so the read that follows is not stale.
const queryOf = (waitForView: boolean) => (waitForView ? { waitFor: COURSE_SEATS_VIEW } : {});

// The calls are plain methods of the derived client: `execute_<command>` takes that command's own payload (a misspelled
// field does not compile) and fails with exactly the problems that command declares, plus the transport's and the Schema's.
export const defineCourseCall = (courseId: string, capacity: number, options: { readonly waitForView: boolean }) =>
  Effect.gen(function* () {
    const client = yield* HttpApiClient.make(makeCourseApi());
    const answer = yield* client.commands.execute_define_course({ payload: { courseId, capacity }, query: queryOf(options.waitForView) });
    return outcomeOf(answer);
  });

export const subscribeCall = (studentId: string, courseId: string, options: { readonly waitForView: boolean }) =>
  Effect.gen(function* () {
    const client = yield* HttpApiClient.make(makeCourseApi());
    const answer = yield* client.commands.execute_subscribe({ payload: { studentId, courseId }, query: queryOf(options.waitForView) });
    return outcomeOf(answer);
  });

export const getCourse = (courseId: string) =>
  Effect.gen(function* () {
    const client = yield* HttpApiClient.make(makeCourseApi());
    return yield* client.courseQueries.getCourse({ params: { courseId } });
  });

const outcomeOf = (answer: { readonly status: "CREATED" | "IDEMPOTENT"; readonly reason: string | null; readonly view?: CommandOutcome["view"] }): CommandOutcome => ({
  status: answer.status,
  reason: answer.reason,
  ...(answer.view === undefined ? {} : { view: answer.view })
});
// #endregion call

// PROBLEMS: what a call can fail with, as the page understands it.

// #region problems
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

// Everything a call above can fail with. These are the TYPES the derived client reports, not guesses: a domain error's problem
// body (told apart by `errorType`, with exactly the `fields` that error declares), the framework's 400/409/500 problems, the
// transport's error and a SchemaError.
export type CallError =
  | Effect.Error<ReturnType<typeof defineCourseCall>>
  | Effect.Error<ReturnType<typeof subscribeCall>>
  | Effect.Error<ReturnType<typeof getCourse>>;

export const problemFromError = (error: CallError): Problem => {
  if ("errorType" in error) {
    switch (error.errorType) {
      case "CourseNotFound":
        return { _tag: "CourseNotFound", courseId: error.fields.courseId };
      case "CourseFull":
        return { _tag: "CourseFull", courseId: error.fields.courseId, capacity: error.fields.capacity };
      case "StudentAtLimit":
        return { _tag: "StudentAtLimit", studentId: error.fields.studentId, limit: error.fields.limit };
      default: {
        // a new declared error with no case above does not compile: `error` would not be `never`
        const unhandled: never = error;
        return unhandled;
      }
    }
  }
  if (Schema.isSchemaError(error)) return { _tag: "Mismatch", detail: error.message };
  if ("title" in error) return { _tag: "Rejected", title: error.title, detail: error.detail };
  return { _tag: "Unreachable" };
};
// #endregion problems

export { CourseResponse };
