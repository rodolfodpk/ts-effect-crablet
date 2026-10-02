import { Effect, Layer } from "effect";
import { HttpApiBuilder } from "effect/http-api";
import type { HttpApi, HttpApiGroup } from "effect/http-api";
import { SqlClient } from "effect/sql";
import { CommandApiBadRequest, domainProblemOf } from "@crablet/commands-http/ProblemDetail";
import { CourseNotFound } from "../domain/enrolment.contract.ts";
import { defaultPageSize, maxPageSize } from "./CourseQueryApi.ts";

interface SeatsRow {
  readonly course_id: string;
  readonly capacity: number;
  readonly subscribers: number;
}

// `text` as a SQL LIKE pattern that matches ids STARTING with it: `\`, `%` and `_` are escaped, or "a_" would also match "ab".
export const likePrefix = (text: string): string => `${text.replace(/[\\%_]/g, "\\$&")}%`;

// `?limit=`: absent means the default; anything but a whole number from 1 to the maximum is a 400.
export const parseLimit = (raw: string | undefined): number | null => {
  if (raw === undefined) return defaultPageSize;
  if (!/^[0-9]+$/.test(raw)) return null;
  const n = Number(raw);
  return n >= 1 && n <= maxPageSize ? n : null;
};

// Same `any`-cast composability boundary commands-http's makeCommandApiGroupLive documents: HttpApiBuilder.group's
// signature cannot prove an arbitrary caller-supplied `Groups` contains this literal group name.
export const makeCourseQueryApiLive = <ApiId extends string, Groups extends HttpApiGroup.Constraint>(
  api: HttpApi.HttpApi<ApiId, Groups>
): Layer.Layer<HttpApiGroup.Service<ApiId, "courseQueries">, never, SqlClient.SqlClient> => {
  const groupBuilder = HttpApiBuilder.group as any;
  return groupBuilder(api, "courseQueries", (handlers: any) =>
    Effect.succeed(
      handlers
        // Keyset pagination on the course id (no OFFSET: a page costs the same however deep it is, and a course added or removed
        // meanwhile cannot shift the pages). One extra row is read to know whether there is a next page.
        .handle("listCourses", ({ query }: { query: { limit?: string; after?: string; q?: string } }) =>
          Effect.gen(function* () {
            const limit = parseLimit(query.limit);
            if (limit === null) {
              return yield* Effect.fail(CommandApiBadRequest.of(`limit must be a whole number from 1 to ${maxPageSize}`));
            }
            const sql = yield* SqlClient.SqlClient;
            const rows = yield* sql.unsafe<SeatsRow>(
              `SELECT course_id, capacity, subscribers FROM course_seats_view
               WHERE ($1::text IS NULL OR course_id > $1) AND ($2::text IS NULL OR course_id LIKE $2 ESCAPE '\\')
               ORDER BY course_id LIMIT $3`,
              [query.after ?? null, query.q === undefined || query.q === "" ? null : likePrefix(query.q), limit + 1]
            );
            const page = rows.slice(0, limit);
            return {
              items: page.map((row) => ({ courseId: row.course_id, capacity: row.capacity, subscribers: row.subscribers, seatsLeft: row.capacity - row.subscribers })),
              next: rows.length > limit ? page[page.length - 1]!.course_id : null
            };
          })
        )
        .handle("getCourse", ({ params }: { params: { courseId: string } }) =>
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
