// The course API's DEFINITION, with nothing that serves it: no database, no view processor, no Node modules. That keeps
// it importable from a browser bundle (the UI in examples/course-enrolment-ui derives its client from it) and from the
// code that builds the OpenAPI description. Serving it is CourseApp.ts.
import { HttpApi } from "effect/http-api";
import { makeCommandApiGroup, withApiInfo } from "@crablet/commands-http";
import { exposedCommandOf, type ExposedCommand } from "@crablet/commands-http/ExposedCommand";
import { DefineCourse, Subscribe } from "./domain/Enrolment.ts";
import { courseQueryGroup } from "./api/CourseQueryApi.ts";

// What a client decodes itself: the read endpoint's response, the command responses, and the domain errors a command can
// answer with (a domain error's `tag` and `fields` are exactly what its problem body carries).
export { CourseResponse } from "./api/CourseQueryApi.ts";
export { CommandCreatedResponse, CommandIdempotentResponse, ViewWaitResult } from "@crablet/commands-http";
export { CourseFull, CourseNotFound, StudentAtLimit } from "./domain/Enrolment.ts";

// The one view a write request may wait for (`?waitFor=course-seats-view`). Its projector and subscription are in
// views/CourseSeatsViewProjector.ts, which re-exports this name.
export const COURSE_SEATS_VIEW = "course-seats-view";

// #region expose
// The write API: one route per command, POST /api/commands/<name>. A command's declared `errors` are what the API
// presents (status from each error's kind) and documents; there is no HTTP code to write per command.
export const courseCommands: Readonly<Record<string, ExposedCommand<any, any>>> = {
  define_course: exposedCommandOf(DefineCourse),
  subscribe: exposedCommandOf(Subscribe)
};
// #endregion expose

export const courseApiInfo = {
  title: "Course Enrolment API",
  version: "1.0.0",
  description: "Define courses and subscribe students: a course holds at most `capacity` students, a student takes at most 3 courses."
} as const;

// The API (separate from serving it, so its OpenAPI description can be produced without starting anything).
export const makeCourseApi = (basePath: `/${string}` = "/api/commands") =>
  withApiInfo(
    HttpApi.make("courseApp")
      .add(makeCommandApiGroup(basePath, courseCommands, { waitableViews: [COURSE_SEATS_VIEW] }))
      .add(courseQueryGroup),
    courseApiInfo
  );
