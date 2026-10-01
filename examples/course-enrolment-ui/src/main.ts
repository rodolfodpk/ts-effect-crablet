// The course-enrolment page, step 1: look a course up and show how many seats are left.
//
// The API definition (routes, request and response Schemas) is the SAME module the server serves
// (course-enrolment-app/CourseApi): the client below is derived from it, nothing about the wire format is re-declared here.
// `import type` for types: Node strips types but does not drop imports, and the tests/e2e import this file without a DOM.
import { Effect, Schema } from "effect";
import { HttpApiClient } from "effect/http-api";
import { Http } from "foldkit";
import type { Runtime, Update } from "foldkit";
import * as AsyncData from "foldkit/asyncData";
import * as Command from "foldkit/command";
import type { Document, HtmlBuilder } from "foldkit/html";
import { defineMessageUnion } from "foldkit/message";
import { CourseResponse, makeCourseApi } from "course-enrolment-app/CourseApi";

// MODEL

// What the page can say about a lookup that did not give a course.
export const Problem = Schema.Struct({ message: Schema.String });
export const Lookup = AsyncData.Schema(CourseResponse, Problem);

export const Model = Schema.Struct({
  courseId: Schema.String,
  lookup: Lookup.schema
});
export type Model = typeof Model.Type

// MESSAGE

export const Message = defineMessageUnion({
  ChangedCourseId: { value: Schema.String },
  SubmittedLookup: {},
  SucceededFetchCourse: { course: CourseResponse },
  FailedFetchCourse: { message: Schema.String }
});
export type Message = typeof Message.Type

// COMMAND

// The derived client: `client.courseQueries.getCourse` is typed from the API definition. A refusal arrives in the error
// channel; this step only needs to tell "no such course" from "something else went wrong".
const describeFailure = (courseId: string, error: unknown): string =>
  typeof error === "object" && error !== null && "errorType" in error && error.errorType === "CourseNotFound"
    ? `There is no course called "${courseId}".`
    : "The server could not be reached, or answered something unexpected.";

export const FetchCourse = Command.define("FetchCourse", {
  args: { courseId: Schema.String },
  messages: [Message.SucceededFetchCourse, Message.FailedFetchCourse],
  execute: ({ courseId }) =>
    Effect.gen(function* () {
      const client = yield* HttpApiClient.make(makeCourseApi());
      const course = yield* client.courseQueries.getCourse({ params: { courseId } });
      return Message.SucceededFetchCourse({ course });
    }).pipe(
      Effect.catch((error) => Effect.succeed(Message.FailedFetchCourse({ message: describeFailure(courseId, error) }))),
      Effect.provide(Http.layer)
    )
});

// UPDATE

export const update = (model: Model, message: Message) =>
  Message.match<Update.Return<Model, Message>>(message, {
    ChangedCourseId: ({ value }) => ({ model: { ...model, courseId: value } }),
    SubmittedLookup: () =>
      model.courseId.trim() === ""
        ? { model }
        : { model: { ...model, lookup: AsyncData.Loading() }, commands: [FetchCourse({ courseId: model.courseId.trim() })] },
    SucceededFetchCourse: ({ course }) => ({ model: { ...model, lookup: Lookup.Success({ data: course }) } }),
    FailedFetchCourse: ({ message }) => ({ model: { ...model, lookup: Lookup.Failure({ error: { message } }) } })
  });

// INIT

export const init: Runtime.ApplicationInit<Model, Message> = () => ({
  model: { courseId: "", lookup: AsyncData.Idle() }
});

// VIEW

const result = (model: Model, h: HtmlBuilder<Message>) =>
  AsyncData.match(model.lookup, {
    onIdle: () => h.p([h.Class("muted")], ["Type a course id to see its seats."]),
    onLoading: () => h.p([h.Class("muted")], ["Looking up..."]),
    onRefreshing: () => h.p([h.Class("muted")], ["Looking up..."]),
    onFailure: (problem) => h.p([h.Class("result error"), h.Role("alert")], [problem.message]),
    onStale: ({ data }) => h.p([h.Class("result")], [`${data.courseId}: ${data.seatsLeft} of ${data.capacity} seats left`]),
    onSuccess: (course) =>
      h.p([h.Class("result")], [`${course.courseId}: ${course.seatsLeft} of ${course.capacity} seats left (${course.subscribers} subscribed)`])
  });

export const view = (model: Model, h: HtmlBuilder<Message>): Document => ({
  title: "Course enrolment",
  body: h.main(
    [],
    [
      h.h1([], ["Course enrolment"]),
      h.form(
        [h.OnSubmit(Message.SubmittedLookup())],
        [
          h.input([h.AriaLabel("Course id"), h.Placeholder("Course id"), h.Value(model.courseId), h.OnInput((value) => Message.ChangedCourseId({ value }))]),
          h.button([h.Type("submit")], ["Look up"])
        ]
      ),
      result(model, h)
    ]
  )
});
