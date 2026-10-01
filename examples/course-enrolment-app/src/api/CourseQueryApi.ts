import * as Schema from "effect/Schema";
import { HttpApiEndpoint, HttpApiGroup } from "effect/http-api";
import { problemSchemaOf } from "@crablet/commands-http/ProblemDetail";
import { CourseNotFound } from "../domain/Enrolment.ts";

// #region query-api
// A read endpoint, hand-written: the response schema is declared here (reads are not derived from the domain model).
// Its 404 is the SAME problem the write API uses for CourseNotFound, so both appear as one component in the description.
export const CourseResponse = Schema.Struct({
  courseId: Schema.String,
  capacity: Schema.Int,
  subscribers: Schema.Int,
  seatsLeft: Schema.Int
});

export const courseQueryGroup = HttpApiGroup.make("courseQueries").add(
  HttpApiEndpoint.get("getCourse", "/api/courses/:courseId", {
    params: { courseId: Schema.String },
    success: CourseResponse,
    error: problemSchemaOf(CourseNotFound) as never
  })
);
// #endregion query-api
