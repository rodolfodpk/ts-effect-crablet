// The course-enrolment page: define a course, subscribe a student, look a course up.
//
// The wire format (routes, response Schemas, the domain errors a refusal carries) comes from the API definition the server
// serves, through ./api.ts. `import type` for types: Node strips types but does not drop imports, and the tests and the
// end-to-end check import this file without a DOM.
import { Effect, Schema, Stream } from "effect";
import { Http, Subscription } from "foldkit";
import type { Runtime, Update } from "foldkit";
import * as AsyncData from "foldkit/asyncData";
import * as Command from "foldkit/command";
import * as FieldValidation from "foldkit/fieldValidation";
import type { Document, HtmlBuilder } from "foldkit/html";
import { defineMessageUnion } from "foldkit/message";
import { CommandOutcome, CourseResponse, Problem, defineCourseCall, getCourse, listCourses, problemFromError, reconnecting, seatMapChanges, subscribeCall } from "./api.ts";

// MODEL

const Text = FieldValidation.Field(Schema.String);
// How the page read the data back after a write: with the write's marker (the server waits for the seat map to have that write), with `latest`
// (the write appended nothing, so it has no marker: the read waits for everything committed so far), or `eventual` (the checkbox is off: the
// read does not wait, so it may be stale).
export const ReadBack = Schema.Literals(["with_marker", "latest", "eventual"]);
export type ReadBack = typeof ReadBack.Type
const Defined = Schema.Struct({ courseId: Schema.String, capacity: Schema.Int, outcome: CommandOutcome, readBack: ReadBack });
const Subscribed = Schema.Struct({ studentId: Schema.String, courseId: Schema.String, outcome: CommandOutcome, readBack: ReadBack });

export const Lookup = AsyncData.Schema(CourseResponse, Problem);
// The course list as shown: every page loaded so far, and the cursor of the next one (null on the last page).
const CoursesShown = Schema.Struct({ items: Schema.Array(CourseResponse), next: Schema.NullOr(Schema.String) });
export const CourseList = AsyncData.Schema(CoursesShown, Problem);
export const DefineResult = AsyncData.Schema(Defined, Problem);
export const SubscribeResult = AsyncData.Schema(Subscribed, Problem);

// The live-update feed: not connected yet, connected, or dropped and waiting to reconnect.
export const FeedState = Schema.Literals(["connecting", "live", "reconnecting"]);

export const Model = Schema.Struct({
  feed: FeedState,
  // After a write, read back with its marker (`?consistentWith=<marker>`): the server answers the read only once the seat map (the view the
  // lookup and the list read) has that write. Off: the read-back asks not to wait (`?consistency=eventual`), and may be stale.
  readWithMarker: Schema.Boolean,
  // The course list: what the user typed into the filter, the filter in effect, and the pages loaded.
  courses: Schema.Struct({ filter: Schema.String, applied: Schema.String, result: CourseList.schema }),
  // The course the last write was about, until the user looks something up themselves: a "no such course" for it means
  // "not in the seat map yet", not "does not exist".
  justWrote: Schema.NullOr(Schema.String),
  lookupCourseId: Schema.String,
  lookup: Lookup.schema,
  define: Schema.Struct({ courseId: Text, capacity: Text, result: DefineResult.schema }),
  subscribe: Schema.Struct({ studentId: Text, courseId: Text, result: SubscribeResult.schema })
});
export type Model = typeof Model.Type

// VALIDATION: the first line of defence, on the page. The server enforces the same rules and answers a 400 problem
// otherwise (it does not report which field, so the page checks fields itself).

const isBlank = (value: string): boolean => value.trim() === "";
export const requiredRules = FieldValidation.makeRules({ required: "Required.", isEmpty: isBlank });
export const capacityRules = FieldValidation.makeRules({
  required: "Required.",
  isEmpty: isBlank,
  rules: [[(value: string) => /^[0-9]+$/.test(value.trim()) && Number(value) >= 1, "Capacity must be a whole number, 1 or more."]]
});

// MESSAGE

export const Message = defineMessageUnion({
  // From the live-update feed (see `subscriptions`): the seat map moved (also the first thing every connection says), or the connection dropped.
  ReceivedSeatMapPing: {},
  LostSeatMapFeed: {},

  ToggledReadWithMarker: {},

  ChangedCourseFilter: { value: Schema.String },
  SubmittedCourseFilter: {},
  ClickedMoreCourses: {},
  ClickedCourse: { courseId: Schema.String },
  SucceededFetchCourses: { items: Schema.Array(CourseResponse), next: Schema.NullOr(Schema.String), append: Schema.Boolean },
  FailedFetchCourses: { problem: Problem },

  ChangedLookupCourseId: { value: Schema.String },
  SubmittedLookup: {},
  SucceededFetchCourse: { course: CourseResponse },
  FailedFetchCourse: { problem: Problem },

  ChangedDefineCourseId: { value: Schema.String },
  ChangedDefineCapacity: { value: Schema.String },
  SubmittedDefineCourse: {},
  SucceededDefineCourse: { courseId: Schema.String, capacity: Schema.Int, outcome: CommandOutcome },
  FailedDefineCourse: { problem: Problem },

  ChangedSubscribeStudentId: { value: Schema.String },
  ChangedSubscribeCourseId: { value: Schema.String },
  SubmittedSubscribe: {},
  SucceededSubscribe: { studentId: Schema.String, courseId: Schema.String, outcome: CommandOutcome },
  FailedSubscribe: { problem: Problem }
});
export type Message = typeof Message.Type

// COMMANDS: each runs one call and ends in a Succeeded or a Failed Message. A refusal is not an exception: it is a
// `Problem` the update function matches on.

// `consistentWith` is a write's marker or `latest`, null for a read that asks nothing (the server's default applies); `eventual` asks not to wait.
export const FetchCourses = Command.define("FetchCourses", {
  args: { q: Schema.String, after: Schema.NullOr(Schema.String), append: Schema.Boolean, consistentWith: Schema.NullOr(Schema.String), eventual: Schema.optionalKey(Schema.Boolean) },
  messages: [Message.SucceededFetchCourses, Message.FailedFetchCourses],
  execute: ({ q, after, append, consistentWith, eventual }) =>
    listCourses({ q, after, consistentWith, ...(eventual === true ? { eventual } : {}) }).pipe(
      Effect.map((page) => Message.SucceededFetchCourses({ items: page.items, next: page.next, append })),
      Effect.catch((error) => Effect.succeed(Message.FailedFetchCourses({ problem: problemFromError(error) }))),
      Effect.provide(Http.layer)
    )
});

export const FetchCourse = Command.define("FetchCourse", {
  args: { courseId: Schema.String, consistentWith: Schema.NullOr(Schema.String), eventual: Schema.optionalKey(Schema.Boolean) },
  messages: [Message.SucceededFetchCourse, Message.FailedFetchCourse],
  execute: ({ courseId, consistentWith, eventual }) =>
    getCourse(courseId, { consistentWith, ...(eventual === true ? { eventual } : {}) }).pipe(
      Effect.map((course) => Message.SucceededFetchCourse({ course })),
      Effect.catch((error) => Effect.succeed(Message.FailedFetchCourse({ problem: problemFromError(error) }))),
      Effect.provide(Http.layer)
    )
});

export const DefineCourse = Command.define("DefineCourse", {
  args: { courseId: Schema.String, capacity: Schema.Int },
  messages: [Message.SucceededDefineCourse, Message.FailedDefineCourse],
  execute: ({ courseId, capacity }) =>
    defineCourseCall(courseId, capacity).pipe(
      Effect.map((outcome) => Message.SucceededDefineCourse({ courseId, capacity, outcome })),
      Effect.catch((error) => Effect.succeed(Message.FailedDefineCourse({ problem: problemFromError(error) }))),
      Effect.provide(Http.layer)
    )
});

// #region command
export const SubscribeStudent = Command.define("SubscribeStudent", {
  args: { studentId: Schema.String, courseId: Schema.String },
  messages: [Message.SucceededSubscribe, Message.FailedSubscribe],
  execute: ({ studentId, courseId }) =>
    subscribeCall(studentId, courseId).pipe(
      Effect.map((outcome) => Message.SucceededSubscribe({ studentId, courseId, outcome })),
      Effect.catch((error) => Effect.succeed(Message.FailedSubscribe({ problem: problemFromError(error) }))),
      Effect.provide(Http.layer)
    )
});
// #endregion command

// UPDATE

// After a write, read the course the write was about: this is "read your own writes". With the checkbox on, the read carries the write's marker
// (or `latest` when the write appended nothing, so it has none) and the server waits for the seat map; off, it asks not to wait and may be stale.
const readBack = (model: Model, courseId: string, outcome: CommandOutcome) => {
  const kind: ReadBack = !model.readWithMarker ? "eventual" : outcome.marker === null ? "latest" : "with_marker";
  const read = kind === "eventual" ? { consistentWith: null, eventual: true } : { consistentWith: kind === "latest" ? "latest" : outcome.marker };
  return {
    kind,
    lookupCourseId: courseId,
    justWrote: courseId,
    lookup: AsyncData.Loading(),
    // the list is read back too, from its first page, under the filter in effect
    commands: [FetchCourse({ courseId, ...read }), FetchCourses({ q: model.courses.applied, after: null, append: false, ...read })]
  };
};

export const update = (model: Model, message: Message) =>
  Message.match<Update.Return<Model, Message>>(message, {
    // The seat map moved: read again what the page shows from it - the list (its first page, under the filter in effect) and the course
    // being looked at. A write made in another tab shows up here without a reload. It is a hint, not data, so the page asks the API.
    ReceivedSeatMapPing: () => ({
      model: { ...model, feed: "live" as const },
      commands: [
        FetchCourses({ q: model.courses.applied, after: null, append: false, consistentWith: null }),
        ...(AsyncData.isSuccess(model.lookup) ? [FetchCourse({ courseId: model.lookup.data.courseId, consistentWith: null })] : [])
      ]
    }),
    LostSeatMapFeed: () => ({ model: { ...model, feed: "reconnecting" as const } }),

    ToggledReadWithMarker: () => ({ model: { ...model, readWithMarker: !model.readWithMarker } }),

    ChangedCourseFilter: ({ value }) => ({ model: { ...model, courses: { ...model.courses, filter: value } } }),
    // Applying a filter starts again from the first page.
    SubmittedCourseFilter: () => ({
      model: { ...model, courses: { ...model.courses, applied: model.courses.filter.trim(), result: AsyncData.Loading() } },
      commands: [FetchCourses({ q: model.courses.filter.trim(), after: null, append: false, consistentWith: null })]
    }),
    ClickedMoreCourses: () =>
      AsyncData.isSuccess(model.courses.result) && model.courses.result.data.next !== null
        ? { model, commands: [FetchCourses({ q: model.courses.applied, after: model.courses.result.data.next, append: true, consistentWith: null })] }
        : { model },
    ClickedCourse: ({ courseId }) => ({
      model: { ...model, lookupCourseId: courseId, justWrote: null, lookup: AsyncData.Loading() },
      commands: [FetchCourse({ courseId, consistentWith: null })]
    }),
    SucceededFetchCourses: ({ items, next, append }) => ({
      model: {
        ...model,
        courses: {
          ...model.courses,
          result: CourseList.Success({
            data: {
              items: append && AsyncData.isSuccess(model.courses.result) ? [...model.courses.result.data.items, ...items] : items,
              next
            }
          })
        }
      }
    }),
    FailedFetchCourses: ({ problem }) => ({ model: { ...model, courses: { ...model.courses, result: CourseList.Failure({ error: problem }) } } }),

    ChangedLookupCourseId: ({ value }) => ({ model: { ...model, lookupCourseId: value } }),
    SubmittedLookup: () =>
      isBlank(model.lookupCourseId)
        ? { model }
        : {
            model: { ...model, justWrote: null, lookup: AsyncData.Loading() },
            commands: [FetchCourse({ courseId: model.lookupCourseId.trim(), consistentWith: null })]
          },
    SucceededFetchCourse: ({ course }) => ({ model: { ...model, lookup: Lookup.Success({ data: course }) } }),
    FailedFetchCourse: ({ problem }) => ({
      model: {
        ...model,
        lookup: Lookup.Failure({
          error: problem._tag === "CourseNotFound" && problem.courseId === model.justWrote ? { _tag: "NotInSeatMapYet", courseId: problem.courseId } : problem
        })
      }
    }),

    ChangedDefineCourseId: ({ value }) => ({
      model: { ...model, define: { ...model.define, courseId: FieldValidation.validate(requiredRules)(value) } }
    }),
    ChangedDefineCapacity: ({ value }) => ({
      model: { ...model, define: { ...model.define, capacity: FieldValidation.validate(capacityRules)(value) } }
    }),
    SubmittedDefineCourse: () => {
      const courseId = FieldValidation.validate(requiredRules)(model.define.courseId.value);
      const capacity = FieldValidation.validate(capacityRules)(model.define.capacity.value);
      return FieldValidation.isValid(requiredRules)(courseId) && FieldValidation.isValid(capacityRules)(capacity)
        ? {
            model: { ...model, define: { courseId, capacity, result: AsyncData.Loading() } },
            commands: [DefineCourse({ courseId: courseId.value.trim(), capacity: Number(capacity.value) })]
          }
        : { model: { ...model, define: { ...model.define, courseId, capacity } } };
    },
    SucceededDefineCourse: ({ courseId, capacity, outcome }) => {
      const read = readBack(model, courseId, outcome);
      return {
        model: {
          ...model,
          lookupCourseId: read.lookupCourseId,
          justWrote: read.justWrote,
          lookup: read.lookup,
          define: { ...model.define, result: DefineResult.Success({ data: { courseId, capacity, outcome, readBack: read.kind } }) }
        },
        commands: read.commands
      };
    },
    FailedDefineCourse: ({ problem }) => ({
      model: { ...model, define: { ...model.define, result: DefineResult.Failure({ error: problem }) } }
    }),

    ChangedSubscribeStudentId: ({ value }) => ({
      model: { ...model, subscribe: { ...model.subscribe, studentId: FieldValidation.validate(requiredRules)(value) } }
    }),
    ChangedSubscribeCourseId: ({ value }) => ({
      model: { ...model, subscribe: { ...model.subscribe, courseId: FieldValidation.validate(requiredRules)(value) } }
    }),
    SubmittedSubscribe: () => {
      const studentId = FieldValidation.validate(requiredRules)(model.subscribe.studentId.value);
      const courseId = FieldValidation.validate(requiredRules)(model.subscribe.courseId.value);
      return FieldValidation.isValid(requiredRules)(studentId) && FieldValidation.isValid(requiredRules)(courseId)
        ? {
            model: { ...model, subscribe: { studentId, courseId, result: AsyncData.Loading() } },
            commands: [SubscribeStudent({ studentId: studentId.value.trim(), courseId: courseId.value.trim() })]
          }
        : { model: { ...model, subscribe: { ...model.subscribe, studentId, courseId } } };
    },
    SucceededSubscribe: ({ studentId, courseId, outcome }) => {
      const read = readBack(model, courseId, outcome);
      return {
        model: {
          ...model,
          lookupCourseId: read.lookupCourseId,
          justWrote: read.justWrote,
          lookup: read.lookup,
          subscribe: { ...model.subscribe, result: SubscribeResult.Success({ data: { studentId, courseId, outcome, readBack: read.kind } }) }
        },
        commands: read.commands
      };
    },
    FailedSubscribe: ({ problem }) => ({
      model: { ...model, subscribe: { ...model.subscribe, result: SubscribeResult.Failure({ error: problem }) } }
    })
  });

// INIT

const emptyField = FieldValidation.NotValidated({ value: "" });

export const init: Runtime.ApplicationInit<Model, Message> = () => ({
  commands: [FetchCourses({ q: "", after: null, append: false, consistentWith: null })],
  model: {
    feed: "connecting",
    readWithMarker: true,
    courses: { filter: "", applied: "", result: AsyncData.Loading() },
    justWrote: null,
    lookupCourseId: "",
    lookup: AsyncData.Idle(),
    define: { courseId: emptyField, capacity: emptyField, result: AsyncData.Idle() },
    subscribe: { studentId: emptyField, courseId: emptyField, result: AsyncData.Idle() }
  }
});

// SUBSCRIPTIONS

// #region subscription
// One connection for the page's life, kept open by `reconnecting` (backoff after a drop). Pings arriving close together (a burst of writes) are
// merged into one read.
export const subscriptions = Subscription.make<Model, Message>()((entry) => ({
  seatMapFeed: entry(
    { enabled: Schema.Boolean },
    {
      modelToDependencies: () => ({ enabled: true }),
      dependenciesToStream: ({ enabled }) =>
        enabled
          ? reconnecting(seatMapChanges().pipe(Stream.debounce("150 millis")), (): Message => Message.ReceivedSeatMapPing(), (): Message => Message.LostSeatMapFeed()).pipe(
              Stream.provide(Http.layer)
            )
          : Stream.empty
    }
  )
}));
// #endregion subscription

// VIEW

// What a refusal says, in the page's words. Each case is a different error the server declared (or the framework raised).
export const describeProblem = (problem: Problem): string => {
  switch (problem._tag) {
    case "CourseNotFound":
      return `There is no course called "${problem.courseId}".`;
    case "CourseFull":
      return `Course "${problem.courseId}" is full (${problem.capacity} seats, all taken).`;
    case "StudentAtLimit":
      return `${problem.studentId} is already in ${problem.limit} courses, the most one student can take.`;
    case "Rejected":
      return `${problem.title}: ${problem.detail}`;
    case "NotInSeatMapYet":
      return `Course "${problem.courseId}" was just written, but the seat map has not caught up with it yet. Look it up again in a moment, or turn on reading back with the write's marker.`;
    case "SeatMapBehind":
      return problem.failed
        ? "The seat map is not updating, so a read that includes your write is not possible right now."
        : "The seat map has not caught up with your write yet. Try again in a moment.";
    case "Mismatch":
      return `That does not match the API definition: ${problem.detail.replaceAll("\n", " ")}`;
    case "Unreachable":
      return "The server could not be reached.";
  }
};

// #region read-back-note
// What the page says about the read it made after a write. With the write's marker the server answered only once the seat map had the write
// (or refused: see `SeatMapBehind`), so the numbers include it; a write that appended nothing (an idempotent repeat) has no marker, so the read
// asked for `latest`; with the checkbox off the read asked not to wait and may be stale.
export const readBackNote = (readBack: ReadBack): string => {
  switch (readBack) {
    case "with_marker":
      return "Read back with this write's marker, so the numbers below include it.";
    case "latest":
      return "Nothing was written, so there is no marker; the read waited for everything committed so far, so the numbers below include any earlier write.";
    case "eventual":
      return "Read back without waiting for the seat map, so the numbers below may be stale.";
  }
};
// #endregion read-back-note

export const feedNote = (feed: Model["feed"]): string => {
  switch (feed) {
    case "live":
      return "Live: the list updates when anyone's write reaches the seat map.";
    case "reconnecting":
      return "Live updates lost; reconnecting...";
    case "connecting":
      return "Connecting for live updates...";
  }
};

const resultOf = <A>(result: AsyncData.AsyncData<A, Problem>, h: HtmlBuilder<Message>, success: (data: A) => string) =>
  AsyncData.match(result, {
    onIdle: () => h.p([h.Class("muted")], [""]),
    onLoading: () => h.p([h.Class("muted")], ["Working..."]),
    onRefreshing: () => h.p([h.Class("muted")], ["Working..."]),
    onFailure: (problem) => h.p([h.Class("result error"), h.Role("alert")], [describeProblem(problem)]),
    onStale: ({ data }) => h.p([h.Class("result")], [success(data)]),
    onSuccess: (data) => h.p([h.Class("result")], [success(data)])
  });

const textField = (
  h: HtmlBuilder<Message>,
  label: string,
  field: FieldValidation.Field<string>,
  onInput: (value: string) => Message
) =>
  h.label(
    [],
    [
      label,
      h.input([h.AriaLabel(label), h.Placeholder(label), h.Value(field.value), h.OnInput(onInput)]),
      FieldValidation.match(field, {
        onNotValidated: () => h.span([], []),
        onValidating: () => h.span([], []),
        onValid: () => h.span([], []),
        onInvalid: ({ errors }) => h.span([h.Class("field-error"), h.Role("alert")], [errors.join(" ")])
      })
    ]
  );

// The course list: a button per course (it opens the course in the lookup below), and "More" while there is another page.
const coursesView = (model: Model, h: HtmlBuilder<Message>) =>
  AsyncData.match(model.courses.result, {
    onIdle: () => h.p([h.Class("muted")], [""]),
    onLoading: () => h.p([h.Class("muted")], ["Loading courses..."]),
    onRefreshing: () => h.p([h.Class("muted")], ["Loading courses..."]),
    onFailure: (problem) => h.p([h.Class("result error"), h.Role("alert")], [describeProblem(problem)]),
    onStale: ({ data }) => courseItems(data, h),
    onSuccess: (data) => courseItems(data, h)
  });

const courseItems = (shown: typeof CoursesShown.Type, h: HtmlBuilder<Message>) =>
  shown.items.length === 0
    ? h.p([h.Class("muted")], ["No courses."])
    : h.div(
        [],
        [
          h.ul(
            [h.Class("courses")],
            shown.items.map((course) =>
              h.li(
                [],
                [h.button([h.Class("link"), h.OnClick(Message.ClickedCourse({ courseId: course.courseId }))], [`${course.courseId}: ${course.seatsLeft} of ${course.capacity} seats left`])]
              )
            )
          ),
          ...(shown.next === null ? [] : [h.button([h.OnClick(Message.ClickedMoreCourses())], ["More"])])
        ]
      );

export const view = (model: Model, h: HtmlBuilder<Message>): Document => ({
  title: "Course enrolment",
  body: h.main(
    [],
    [
      h.h1([], ["Course enrolment"]),
      h.p([h.Class("muted"), h.AriaLabel("Live updates")], [feedNote(model.feed)]),

      h.label(
        [h.Class("wait-toggle")],
        [
          h.input([h.Type("checkbox"), h.AriaLabel("Read back with the write's marker"), h.Checked(model.readWithMarker), h.OnClick(Message.ToggledReadWithMarker())]),
          "Read back with my write's marker (?consistentWith=<marker>); unticked: do not wait (?consistency=eventual)"
        ]
      ),

      h.section(
        [h.AriaLabel("Courses")],
        [
          h.h2([], ["Courses"]),
          h.form(
            [h.OnSubmit(Message.SubmittedCourseFilter()), h.AriaLabel("Course filter form")],
            [
              h.input([
                h.AriaLabel("Filter courses"),
                h.Placeholder("Id starts with..."),
                h.Value(model.courses.filter),
                h.OnInput((value) => Message.ChangedCourseFilter({ value }))
              ]),
              h.button([h.Type("submit")], ["Filter"])
            ]
          ),
          coursesView(model, h)
        ]
      ),

      h.section(
        [h.AriaLabel("Define a course")],
        [
          h.h2([], ["Define a course"]),
          h.form(
            [h.OnSubmit(Message.SubmittedDefineCourse()), h.AriaLabel("Define a course form")],
            [
              textField(h, "Course id", model.define.courseId, (value) => Message.ChangedDefineCourseId({ value })),
              textField(h, "Capacity", model.define.capacity, (value) => Message.ChangedDefineCapacity({ value })),
              h.button([h.Type("submit")], ["Define"])
            ]
          ),
          resultOf(model.define.result, h, (c) => `Defined course ${c.courseId} with ${c.capacity} seats. ${readBackNote(c.readBack)}`.trim())
        ]
      ),

      h.section(
        [h.AriaLabel("Subscribe a student")],
        [
          h.h2([], ["Subscribe a student"]),
          h.form(
            [h.OnSubmit(Message.SubmittedSubscribe()), h.AriaLabel("Subscribe form")],
            [
              textField(h, "Student id", model.subscribe.studentId, (value) => Message.ChangedSubscribeStudentId({ value })),
              textField(h, "Course", model.subscribe.courseId, (value) => Message.ChangedSubscribeCourseId({ value })),
              h.button([h.Type("submit")], ["Subscribe"])
            ]
          ),
          resultOf(model.subscribe.result, h, (s) =>
            `${
              s.outcome.status === "CREATED"
                ? `${s.studentId} is now subscribed to ${s.courseId}.`
                : `${s.studentId} was already subscribed to ${s.courseId} (${s.outcome.reason ?? "nothing to do"}).`
            } ${readBackNote(s.readBack)}`.trim()
          )
        ]
      ),

      h.section(
        [h.AriaLabel("Look a course up")],
        [
          h.h2([], ["Look a course up"]),
          h.form(
            [h.OnSubmit(Message.SubmittedLookup()), h.AriaLabel("Lookup form")],
            [
              h.input([
                h.AriaLabel("Lookup course id"),
                h.Placeholder("Course id"),
                h.Value(model.lookupCourseId),
                h.OnInput((value) => Message.ChangedLookupCourseId({ value }))
              ]),
              h.button([h.Type("submit")], ["Look up"])
            ]
          ),
          resultOf(
            model.lookup,
            h,
            (course) => `${course.courseId}: ${course.seatsLeft} of ${course.capacity} seats left (${course.subscribers} subscribed)`
          )
        ]
      )
    ]
  )
});
