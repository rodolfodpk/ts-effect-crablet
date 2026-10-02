// The course-enrolment page: define a course, subscribe a student, look a course up.
//
// The wire format (routes, response Schemas, the domain errors a refusal carries) comes from the API definition the server
// serves, through ./api.ts. `import type` for types: Node strips types but does not drop imports, and the tests and the
// end-to-end check import this file without a DOM.
import { Effect, Schema } from "effect";
import { Http } from "foldkit";
import type { Runtime, Update } from "foldkit";
import * as AsyncData from "foldkit/asyncData";
import * as Command from "foldkit/command";
import * as FieldValidation from "foldkit/fieldValidation";
import type { Document, HtmlBuilder } from "foldkit/html";
import { defineMessageUnion } from "foldkit/message";
import { CommandOutcome, CourseResponse, Problem, getCourse, problemFromError, runCommand } from "./api.ts";

// MODEL

const Text = FieldValidation.Field(Schema.String);
const Defined = Schema.Struct({ courseId: Schema.String, capacity: Schema.Int, outcome: CommandOutcome });
const Subscribed = Schema.Struct({ studentId: Schema.String, courseId: Schema.String, outcome: CommandOutcome });

export const Lookup = AsyncData.Schema(CourseResponse, Problem);
export const DefineResult = AsyncData.Schema(Defined, Problem);
export const SubscribeResult = AsyncData.Schema(Subscribed, Problem);

export const Model = Schema.Struct({
  // Ask the server to answer a write only once the seat map (the view the lookup reads) has caught up with it.
  waitForView: Schema.Boolean,
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
  ToggledWaitForView: {},

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

export const FetchCourse = Command.define("FetchCourse", {
  args: { courseId: Schema.String },
  messages: [Message.SucceededFetchCourse, Message.FailedFetchCourse],
  execute: ({ courseId }) =>
    getCourse(courseId).pipe(
      Effect.map((course) => Message.SucceededFetchCourse({ course })),
      Effect.catch((error) => Effect.succeed(Message.FailedFetchCourse({ problem: problemFromError(error) }))),
      Effect.provide(Http.layer)
    )
});

export const DefineCourse = Command.define("DefineCourse", {
  args: { courseId: Schema.String, capacity: Schema.Int, waitForView: Schema.Boolean },
  messages: [Message.SucceededDefineCourse, Message.FailedDefineCourse],
  execute: ({ courseId, capacity, waitForView }) =>
    runCommand("define_course", { courseId, capacity }, { waitForView }).pipe(
      Effect.map((outcome) => Message.SucceededDefineCourse({ courseId, capacity, outcome })),
      Effect.catch((error) => Effect.succeed(Message.FailedDefineCourse({ problem: problemFromError(error) }))),
      Effect.provide(Http.layer)
    )
});

export const SubscribeStudent = Command.define("SubscribeStudent", {
  args: { studentId: Schema.String, courseId: Schema.String, waitForView: Schema.Boolean },
  messages: [Message.SucceededSubscribe, Message.FailedSubscribe],
  execute: ({ studentId, courseId, waitForView }) =>
    runCommand("subscribe", { studentId, courseId }, { waitForView }).pipe(
      Effect.map((outcome) => Message.SucceededSubscribe({ studentId, courseId, outcome })),
      Effect.catch((error) => Effect.succeed(Message.FailedSubscribe({ problem: problemFromError(error) }))),
      Effect.provide(Http.layer)
    )
});

// UPDATE

// After a write, read the course the write was about: this is "read your own writes". Whether that read is right depends
// on whether the write waited for the seat map (see `waitForView`).
const readBack = (courseId: string) => ({
  lookupCourseId: courseId,
  justWrote: courseId,
  lookup: AsyncData.Loading(),
  command: FetchCourse({ courseId })
});

export const update = (model: Model, message: Message) =>
  Message.match<Update.Return<Model, Message>>(message, {
    ToggledWaitForView: () => ({ model: { ...model, waitForView: !model.waitForView } }),

    ChangedLookupCourseId: ({ value }) => ({ model: { ...model, lookupCourseId: value } }),
    SubmittedLookup: () =>
      isBlank(model.lookupCourseId)
        ? { model }
        : {
            model: { ...model, justWrote: null, lookup: AsyncData.Loading() },
            commands: [FetchCourse({ courseId: model.lookupCourseId.trim() })]
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
            commands: [DefineCourse({ courseId: courseId.value.trim(), capacity: Number(capacity.value), waitForView: model.waitForView })]
          }
        : { model: { ...model, define: { ...model.define, courseId, capacity } } };
    },
    SucceededDefineCourse: ({ courseId, capacity, outcome }) => {
      const read = readBack(courseId);
      return {
        model: {
          ...model,
          lookupCourseId: read.lookupCourseId,
          justWrote: read.justWrote,
          lookup: read.lookup,
          define: { ...model.define, result: DefineResult.Success({ data: { courseId, capacity, outcome } }) }
        },
        commands: [read.command]
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
            commands: [SubscribeStudent({ studentId: studentId.value.trim(), courseId: courseId.value.trim(), waitForView: model.waitForView })]
          }
        : { model: { ...model, subscribe: { ...model.subscribe, studentId, courseId } } };
    },
    SucceededSubscribe: ({ studentId, courseId, outcome }) => {
      const read = readBack(courseId);
      return {
        model: {
          ...model,
          lookupCourseId: read.lookupCourseId,
          justWrote: read.justWrote,
          lookup: read.lookup,
          subscribe: { ...model.subscribe, result: SubscribeResult.Success({ data: { studentId, courseId, outcome } }) }
        },
        commands: [read.command]
      };
    },
    FailedSubscribe: ({ problem }) => ({
      model: { ...model, subscribe: { ...model.subscribe, result: SubscribeResult.Failure({ error: problem }) } }
    })
  });

// INIT

const emptyField = FieldValidation.NotValidated({ value: "" });

export const init: Runtime.ApplicationInit<Model, Message> = () => ({
  model: {
    waitForView: true,
    justWrote: null,
    lookupCourseId: "",
    lookup: AsyncData.Idle(),
    define: { courseId: emptyField, capacity: emptyField, result: AsyncData.Idle() },
    subscribe: { studentId: emptyField, courseId: emptyField, result: AsyncData.Idle() }
  }
});

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
      return `Course "${problem.courseId}" was just written, but the seat map has not caught up with it yet. Look it up again in a moment, or turn waiting on.`;
    case "Mismatch":
      return `That does not match the API definition: ${problem.detail.replaceAll("\n", " ")}`;
    case "Unreachable":
      return "The server could not be reached.";
  }
};

// Whether the seat map (the view the lookup reads) had caught up with the write when the server answered. Without
// `?waitFor` the server does not know or say; with it, it says, and a miss is reported in the body, never as an error.
export const viewNote = (outcome: CommandOutcome): string => {
  const view = outcome.view;
  if (view === undefined) return "Not waiting for the seat map, so the numbers below may be stale.";
  if (view.caughtUp) return "The seat map had caught up when this answered.";
  switch (view.reason) {
    case "nothing_appended":
      return "";
    case "timeout":
      return "The seat map had not caught up in time, so the numbers below may be stale.";
    case "view_failed":
      return "The seat map is not updating, so the numbers below are out of date.";
    default:
      return "Could not tell whether the seat map caught up, so the numbers below may be stale.";
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

export const view = (model: Model, h: HtmlBuilder<Message>): Document => ({
  title: "Course enrolment",
  body: h.main(
    [],
    [
      h.h1([], ["Course enrolment"]),

      h.label(
        [h.Class("wait-toggle")],
        [
          h.input([h.Type("checkbox"), h.AriaLabel("Wait for the seat map"), h.Checked(model.waitForView), h.OnClick(Message.ToggledWaitForView())]),
          "Wait for the seat map before a write answers (?waitFor=course-seats-view)"
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
          resultOf(model.define.result, h, (c) => `Defined course ${c.courseId} with ${c.capacity} seats. ${viewNote(c.outcome)}`.trim())
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
            } ${viewNote(s.outcome)}`.trim()
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
