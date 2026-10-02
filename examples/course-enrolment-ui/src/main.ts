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
const Defined = Schema.Struct({ courseId: Schema.String, capacity: Schema.Int });
const Subscribed = Schema.Struct({ studentId: Schema.String, courseId: Schema.String, outcome: CommandOutcome });

export const Lookup = AsyncData.Schema(CourseResponse, Problem);
export const DefineResult = AsyncData.Schema(Defined, Problem);
export const SubscribeResult = AsyncData.Schema(Subscribed, Problem);

export const Model = Schema.Struct({
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
  ChangedLookupCourseId: { value: Schema.String },
  SubmittedLookup: {},
  SucceededFetchCourse: { course: CourseResponse },
  FailedFetchCourse: { problem: Problem },

  ChangedDefineCourseId: { value: Schema.String },
  ChangedDefineCapacity: { value: Schema.String },
  SubmittedDefineCourse: {},
  SucceededDefineCourse: { courseId: Schema.String, capacity: Schema.Int },
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
  args: { courseId: Schema.String, capacity: Schema.Int },
  messages: [Message.SucceededDefineCourse, Message.FailedDefineCourse],
  execute: ({ courseId, capacity }) =>
    runCommand("define_course", { courseId, capacity }).pipe(
      Effect.map(() => Message.SucceededDefineCourse({ courseId, capacity })),
      Effect.catch((error) => Effect.succeed(Message.FailedDefineCourse({ problem: problemFromError(error) }))),
      Effect.provide(Http.layer)
    )
});

export const SubscribeStudent = Command.define("SubscribeStudent", {
  args: { studentId: Schema.String, courseId: Schema.String },
  messages: [Message.SucceededSubscribe, Message.FailedSubscribe],
  execute: ({ studentId, courseId }) =>
    runCommand("subscribe", { studentId, courseId }).pipe(
      Effect.map((outcome) => Message.SucceededSubscribe({ studentId, courseId, outcome })),
      Effect.catch((error) => Effect.succeed(Message.FailedSubscribe({ problem: problemFromError(error) }))),
      Effect.provide(Http.layer)
    )
});

// UPDATE

export const update = (model: Model, message: Message) =>
  Message.match<Update.Return<Model, Message>>(message, {
    ChangedLookupCourseId: ({ value }) => ({ model: { ...model, lookupCourseId: value } }),
    SubmittedLookup: () =>
      isBlank(model.lookupCourseId)
        ? { model }
        : { model: { ...model, lookup: AsyncData.Loading() }, commands: [FetchCourse({ courseId: model.lookupCourseId.trim() })] },
    SucceededFetchCourse: ({ course }) => ({ model: { ...model, lookup: Lookup.Success({ data: course }) } }),
    FailedFetchCourse: ({ problem }) => ({ model: { ...model, lookup: Lookup.Failure({ error: problem }) } }),

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
    SucceededDefineCourse: ({ courseId, capacity }) => ({
      model: { ...model, define: { ...model.define, result: DefineResult.Success({ data: { courseId, capacity } }) } }
    }),
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
    SucceededSubscribe: ({ studentId, courseId, outcome }) => ({
      model: { ...model, subscribe: { ...model.subscribe, result: SubscribeResult.Success({ data: { studentId, courseId, outcome } }) } }
    }),
    FailedSubscribe: ({ problem }) => ({
      model: { ...model, subscribe: { ...model.subscribe, result: SubscribeResult.Failure({ error: problem }) } }
    })
  });

// INIT

const emptyField = FieldValidation.NotValidated({ value: "" });

export const init: Runtime.ApplicationInit<Model, Message> = () => ({
  model: {
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
    case "Mismatch":
      return `That does not match the API definition: ${problem.detail.replaceAll("\n", " ")}`;
    case "Unreachable":
      return "The server could not be reached.";
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
          resultOf(model.define.result, h, (c) => `Defined course ${c.courseId} with ${c.capacity} seats.`)
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
            s.outcome.status === "CREATED"
              ? `${s.studentId} is now subscribed to ${s.courseId}.`
              : `${s.studentId} was already subscribed to ${s.courseId} (${s.outcome.reason ?? "nothing to do"}).`
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
