// The page's view of the course API: the calls it makes, and what can go wrong with each.
//
// Everything about the wire format comes from the API definition the server serves (course-enrolment-app/CourseApi):
// the routes, the request and response Schemas, and for every command the exact set of problems it can answer with. The
// derived client is typed per command from that definition, so this file keeps no copy of any of it and needs no cast.
// It imports no foldkit, so tests and the end-to-end check can use it.
import { Duration, Effect, Ref, Schema, Stream } from "effect";
import { HttpApiClient } from "effect/http-api";
import { COURSE_SEATS_VIEW, CourseResponse, makeCourseApi } from "course-enrolment-app/CourseApi";

// #region client
// Where the API is. Unset: relative URLs, which works when the page and the API share an origin (the Vite dev proxy does that, and so
// would serving the page from the API server). With VITE_API_URL set (for example http://localhost:8080) the page calls that origin
// directly, which needs CORS on the server (COURSES_CORS_ORIGINS=<the page's origin>, see @crablet/commands-http/Cors).
// `import.meta.env` is Vite's (and Bun's); under plain Node, as in the integration test, it is absent and the base is relative.
export const apiBaseUrl: string | undefined = (import.meta as unknown as { env?: { VITE_API_URL?: string } }).env?.VITE_API_URL || undefined;
const makeClient = () => HttpApiClient.make(makeCourseApi(), apiBaseUrl === undefined ? {} : { baseUrl: apiBaseUrl });
// #endregion client

// #region feed
// The live-update feed: a stream of "the seat map moved" pings (`GET /api/views/changes`, server-sent events), typed by the same API
// definition. It ends when the connection does (the server closes each after a maximum lifetime, or the network drops); `reconnecting` below
// opens it again.
export const seatMapChanges = () =>
  Stream.unwrap(Effect.flatMap(makeClient(), (client) => client.courseFeed.viewChanges({ query: { views: COURSE_SEATS_VIEW } })));

// How long to wait before reconnecting after `failures` connections in a row that ended without delivering anything: 0.5 s, doubling, at most 30 s.
export const reconnectDelay = (failures: number): Duration.Duration =>
  Duration.millis(Math.min(30_000, 500 * 2 ** Math.max(0, failures - 1)));

// Keeps a feed open for ever. Each ping becomes `onPing()`. When the connection ends, `onLost()` is sent, then it waits (`reconnectDelay`, reset by the
// next ping) and connects again. The opening ping of every connection is what makes the page read again after a gap.
export const reconnecting = <A, E, R, M>(
  open: Stream.Stream<A, E, R>,
  onPing: () => M,
  onLost: () => M,
  delay: (failures: number) => Duration.Duration = reconnectDelay
): Stream.Stream<M, never, R> =>
  Stream.unwrap(
    Effect.gen(function* () {
      const failures = yield* Ref.make(0);
      const delivered = yield* Ref.make(false);
      // A connection that delivered something and then ended (the server's lifetime limit) is not a failure: it reconnects after the base delay.
      const next = Ref.get(delivered).pipe(
        Effect.flatMap((ok) => (ok ? Ref.set(failures, 0).pipe(Effect.as(1)) : Ref.updateAndGet(failures, (n) => n + 1)))
      );
      const once = Stream.fromEffect(Ref.set(delivered, false)).pipe(
        Stream.drain,
        Stream.concat(open),
        Stream.tap(() => Ref.set(delivered, true)),
        Stream.map(onPing),
        Stream.catch(() => Stream.empty),
        Stream.concat(
          Stream.fromEffect(next).pipe(
            Stream.flatMap((n) => Stream.make(onLost()).pipe(Stream.concat(Stream.fromEffect(Effect.sleep(delay(n))).pipe(Stream.drain))))
          )
        )
      );
      return Stream.forever(once);
    })
  );
// #endregion feed

// What a command answered: created, or "already done" (an idempotent repeat) with the reason, and the write's marker (null when nothing was
// written): the token that makes the next read include this write (`?consistentWith=<marker>`).
export const CommandOutcome = Schema.Struct({
  status: Schema.Literals(["CREATED", "IDEMPOTENT"]),
  reason: Schema.NullOr(Schema.String),
  marker: Schema.NullOr(Schema.String)
});
export type CommandOutcome = typeof CommandOutcome.Type

// #region call
// The calls are plain methods of the derived client: `execute_<command>` takes that command's own payload (a misspelled
// field does not compile) and fails with exactly the problems that command declares, plus the transport's and the Schema's.
// A write does not wait for anything: it answers once it has committed, with the marker of what it wrote.
export const defineCourseCall = (courseId: string, capacity: number) =>
  Effect.gen(function* () {
    const client = yield* makeClient();
    const answer = yield* client.commands.execute_define_course({ payload: { courseId, capacity }, query: {} });
    return outcomeOf(answer);
  });

export const subscribeCall = (studentId: string, courseId: string) =>
  Effect.gen(function* () {
    const client = yield* makeClient();
    const answer = yield* client.commands.execute_subscribe({ payload: { studentId, courseId }, query: {} });
    return outcomeOf(answer);
  });

// A read can carry a write's marker: `consistentWith` makes the server answer only once the seat map has that write (a 503 if it cannot in
// time). Without one the read answers at once with whatever the seat map has.
const consistentWithOf = (marker: string | null) => (marker === null ? {} : { consistentWith: marker });

// One page of the course list. `after` is the previous page's `next`; `q` keeps ids that start with it. A read resolves to
// `{ body, headers }` (the header marks a stale answer, which this page never asks for): the page wants the body.
export const listCourses = (options: { readonly q: string; readonly after: string | null; readonly consistentWith: string | null }) =>
  Effect.gen(function* () {
    const client = yield* makeClient();
    const answer = yield* client.courseQueries.listCourses({
      query: {
        ...(options.q === "" ? {} : { q: options.q }),
        ...(options.after === null ? {} : { after: options.after }),
        ...consistentWithOf(options.consistentWith)
      }
    });
    return answer.body;
  });

export const getCourse = (courseId: string, consistentWith: string | null) =>
  Effect.gen(function* () {
    const client = yield* makeClient();
    const answer = yield* client.courseQueries.getCourse({ params: { courseId }, query: consistentWithOf(consistentWith) });
    return answer.body;
  });

const outcomeOf = (answer: { readonly status: "CREATED" | "IDEMPOTENT"; readonly reason: string | null; readonly marker: string | null }): CommandOutcome => ({
  status: answer.status,
  reason: answer.reason,
  marker: answer.marker
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
  // response Schema; either failure is a SchemaError whose message names the field (`at ["capacity"]`). (The server's own 400
  // names the failing fields too, in its `errors` member, for clients that do not validate first.)
  Schema.TaggedStruct("Mismatch", { detail: Schema.String }),
  // Not from the server: the page's reading of a "no such course" it just wrote itself (the seat map lags behind writes).
  Schema.TaggedStruct("NotInSeatMapYet", { courseId: Schema.String }),
  // A read that asked to include a write was refused (503): the seat map had not caught up in time (try again), or is not updating at all.
  Schema.TaggedStruct("SeatMapBehind", { failed: Schema.Boolean }),
  Schema.TaggedStruct("Unreachable", {})
]);
export type Problem = typeof Problem.Type

// Everything a call above can fail with. These are the TYPES the derived client reports, not guesses: a domain error's problem
// body (told apart by `errorType`, with exactly the `fields` that error declares), the framework's 400/409/500 problems, the
// transport's error and a SchemaError.
export type CallError =
  | Effect.Error<ReturnType<typeof defineCourseCall>>
  | Effect.Error<ReturnType<typeof subscribeCall>>
  | Effect.Error<ReturnType<typeof getCourse>>
  | Effect.Error<ReturnType<typeof listCourses>>;

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
  // the 503 a read answers when the seat map cannot catch up to the write it was asked to include (told apart by its `reason`)
  if ("reason" in error && "views" in error) return { _tag: "SeatMapBehind", failed: error.reason === "view_failed" };
  if ("title" in error) {
    // a 400 for a body that did not match the input says which fields (`errors`), by path
    const fields = "errors" in error && error.errors !== undefined ? error.errors.map((issue) => `${issue.path.join(".") || "(body)"}: ${issue.message}`).join("; ") : "";
    return { _tag: "Rejected", title: error.title, detail: fields === "" ? error.detail : `${error.detail} (${fields})` };
  }
  return { _tag: "Unreachable" };
};
// #endregion problems

export { CourseResponse };
