import { Effect, Layer } from "effect";
import { HttpApiBuilder } from "effect/http-api";
import type { HttpApi, HttpApiGroup } from "effect/http-api";
import { SqlClient } from "effect/sql";
import { domainProblemOf } from "@crablet/commands-http/ProblemDetail";
import { CourseNotFound } from "../domain/Enrolment.ts";

interface SeatsRow {
  readonly course_id: string;
  readonly capacity: number;
  readonly subscribers: number;
}

// Same `any`-cast composability boundary commands-http's makeCommandApiGroupLive documents: HttpApiBuilder.group's
// signature cannot prove an arbitrary caller-supplied `Groups` contains this literal group name.
export const makeCourseQueryApiLive = <ApiId extends string, Groups extends HttpApiGroup.Constraint>(
  api: HttpApi.HttpApi<ApiId, Groups>
): Layer.Layer<HttpApiGroup.Service<ApiId, "courseQueries">, never, SqlClient.SqlClient> => {
  const groupBuilder = HttpApiBuilder.group as any;
  return groupBuilder(api, "courseQueries", (handlers: any) =>
    Effect.succeed(
      handlers.handle("getCourse", ({ params }: { params: { courseId: string } }) =>
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          const rows = yield* sql.unsafe<SeatsRow>("SELECT course_id, capacity, subscribers FROM course_seats_view WHERE course_id = $1", [
            params.courseId
          ]);
          const row = rows[0];
          if (!row) return yield* Effect.fail(domainProblemOf("not_found", new CourseNotFound({ courseId: params.courseId })));
          return { courseId: row.course_id, capacity: row.capacity, subscribers: row.subscribers, seatsLeft: row.capacity - row.subscribers };
        })
      )
    )
  );
};
