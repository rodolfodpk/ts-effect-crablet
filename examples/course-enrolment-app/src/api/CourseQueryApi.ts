import * as Schema from "effect/Schema";
import { HttpApiEndpoint, HttpApiGroup } from "effect/http-api";
import { BadRequestProblem } from "@crablet/commands-http";
import { problemSchemaOf } from "@crablet/commands-http/ProblemDetail";
import { CourseNotFound } from "../domain/enrolment.contract.ts";

// #region query-api
// A read endpoint, hand-written: the response schema is declared here (reads are not derived from the domain model).
// Its 404 is the SAME problem the write API uses for CourseNotFound, so both appear as one component in the description.
export const CourseResponse = Schema.Struct({
  courseId: Schema.String,
  capacity: Schema.Int,
  subscribers: Schema.Int,
  seatsLeft: Schema.Int
});

// One page of courses, in course id order. `next` is the cursor of the following page, or null on the last one; pass it back as `after`.
export const CoursePage = Schema.Struct({
  items: Schema.Array(CourseResponse),
  next: Schema.NullOr(Schema.String)
});

export const defaultPageSize = 20;
export const maxPageSize = 100;

// Query values arrive as strings. They are plain strings here on purpose and validated by the handler (like `?waitFor`), so a bad
// value answers with the same problem body as every other 400 instead of the HTTP framework's empty-bodied default.
export const listCoursesQuery = {
  limit: Schema.optionalKey(
    Schema.String.annotate({ description: `How many courses to return: a whole number from 1 to ${maxPageSize} (default ${defaultPageSize}).` } as never)
  ),
  after: Schema.optionalKey(
    Schema.String.annotate({ description: "Return the courses after this cursor: the `next` of the previous page. Opaque to clients." } as never)
  ),
  q: Schema.optionalKey(
    Schema.String.annotate({ description: "Only courses whose id starts with this text (case-sensitive)." } as never)
  )
};

export const courseQueryGroup = HttpApiGroup.make("courseQueries")
  .add(
    HttpApiEndpoint.get("getCourse", "/api/courses/:courseId", {
      params: { courseId: Schema.String },
      success: CourseResponse,
      error: problemSchemaOf(CourseNotFound)
    })
  )
  .add(
    HttpApiEndpoint.get("listCourses", "/api/courses", {
      query: listCoursesQuery,
      success: CoursePage,
      error: BadRequestProblem
    })
  );
// #endregion query-api
