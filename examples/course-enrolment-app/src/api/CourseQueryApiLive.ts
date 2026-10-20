import { Effect, Layer, Option, Schema } from "effect";
import { HttpApiBuilder } from "effect/http-api";
import { SqlClient, SqlSchema } from "effect/sql";
import { CommandApiBadRequest, problemOf } from "@crablet/commands-http/ProblemDetail";
import { makeConsistentRead } from "@crablet/views-http";
import { defaultReadConsistency, type ReadConsistencyConfig } from "@crablet/views-http/ReadConsistency";
import type { CourseApi } from "../CourseApi.ts";
import { CourseNotFound } from "../domain/enrolment.contract.ts";
import { defaultPageSize, maxPageSize } from "./CourseQueryApi.ts";
import { CourseSeatsView } from "../views/CourseSeatsViewProjector.ts";
import { CourseEnrolmentsView } from "../views/CourseEnrolmentsViewProjector.ts";

// `text` as a SQL LIKE pattern that matches ids STARTING with it: `\`, `%` and `_` are escaped, or "a_" would also match "ab".
export const likePrefix = (text: string): string => `${text.replace(/[\\%_]/g, "\\$&")}%`;

// #region row-schema
// A row of course_seats_view as the database sends it, checked on every read: a column that was renamed or changed type fails here, naming the field.
const SeatsRow = Schema.Struct({ course_id: Schema.String, capacity: Schema.Int, subscribers: Schema.Int });

// One page of courses by keyset on course_id. `after` and `q` are optional filters (null: none); the caller asks for one row more than the page, to know whether there is a next page.
// (LIKE escapes with a backslash unless told otherwise, which is what likePrefix assumes.)
const listSeats = (sql: SqlClient.SqlClient) =>
  SqlSchema.findAll({
    Request: Schema.Struct({ after: Schema.NullOr(Schema.String), q: Schema.NullOr(Schema.String), limit: Schema.Number }),
    Result: SeatsRow,
    execute: ({ after, q, limit }) => {
      const where: Array<string> = [];
      const params: Array<string | number> = [];
      if (after !== null) where.push(`course_id > $${params.push(after)}`);
      if (q !== null && q !== "") where.push(`course_id LIKE $${params.push(likePrefix(q))}`);
      return sql.unsafe(
        `SELECT course_id, capacity, subscribers FROM course_seats_view${where.length > 0 ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY course_id LIMIT $${params.push(limit)}`,
        params
      );
    }
  });

const findSeats = (sql: SqlClient.SqlClient) =>
  SqlSchema.findOneOption({
    Request: Schema.Struct({ courseId: Schema.String }),
    Result: SeatsRow,
    execute: ({ courseId }) => sql.unsafe("SELECT course_id, capacity, subscribers FROM course_seats_view WHERE course_id = $1", [courseId])
  });
// #endregion row-schema

// A row of course_enrolments_view as the database sends it.
const EnrolmentRow = Schema.Struct({ student_id: Schema.String, seat_number: Schema.Int });

// The students of one course, by seat number: the read side of the view written with its own SQL.
const listEnrolments = (sql: SqlClient.SqlClient) =>
  SqlSchema.findAll({
    Request: Schema.Struct({ courseId: Schema.String }),
    Result: EnrolmentRow,
    execute: ({ courseId }) => sql.unsafe("SELECT student_id, seat_number FROM course_enrolments_view WHERE course_id = $1 ORDER BY seat_number", [courseId])
  });

// `?limit=`: absent means the default; anything but a whole number from 1 to the maximum is a 400.
export const parseLimit = (raw: string | undefined): number | null => {
  if (raw === undefined) return defaultPageSize;
  if (!/^[0-9]+$/.test(raw)) return null;
  const n = Number(raw);
  return n >= 1 && n <= maxPageSize ? n : null;
};

// #region read-consistency
// How consistent the reads are (ADR-0015). The server default: strict, and a read with no marker waits for the head of the log, so a read made
// after a write includes it. A read that carries a write's marker (`?consistentWith=<marker>`) waits only for that write. If the seats view
// is not there in time the read is a 503, never a wrong answer. This app lets a client loosen a read (`clientMayRelax`):
// `?consistency=eventual` answers at once and may be stale, `?consistency=bounded` waits up to the timeout and then answers marked stale.
export const courseReadConsistency: ReadConsistencyConfig = { ...defaultReadConsistency, clientMayRelax: true };
const consistentRead = makeConsistentRead({ config: courseReadConsistency });
// #endregion read-consistency

// The read group, implemented against the course API itself: each handler's request and response are checked against its endpoint.
export const makeCourseQueryApiLive = (api: CourseApi) =>
  HttpApiBuilder.group(api, "courseQueries", (handlers) =>
    Effect.succeed(
      handlers
        // Keyset pagination on the course id (no OFFSET: a page costs the same however deep it is, and a course added or removed
        // meanwhile cannot shift the pages). One extra row is read to know whether there is a next page.
        // `parse` validates limit, cursor and filter BEFORE the read waits for the view, so a bad request is a 400 at once.
        .handle(
          "listCourses",
          consistentRead(
            {
              reads: [CourseSeatsView],
              parse: (request) => {
                const limit = parseLimit(request.query.limit);
                return limit === null
                  ? Effect.fail(CommandApiBadRequest.of(`limit must be a whole number from 1 to ${maxPageSize}`))
                  : Effect.succeed({ limit, after: request.query.after, q: request.query.q });
              }
            },
            ({ limit, after, q }) =>
              Effect.gen(function* () {
                const sql = yield* SqlClient.SqlClient;
                const rows = yield* listSeats(sql)({ after: after ?? null, q: q ?? null, limit: limit + 1 }).pipe(Effect.orDie);
                const page = rows.slice(0, limit);
                return {
                  items: page.map((row) => ({ courseId: row.course_id, capacity: row.capacity, subscribers: row.subscribers, seatsLeft: row.capacity - row.subscribers })),
                  next: rows.length > limit ? page[page.length - 1]!.course_id : null
                };
              })
          )
        )
        // A course with no enrolments (or one that does not exist) answers an empty list: the view holds rows only for students who subscribed.
        .handle(
          "getEnrolments",
          consistentRead(
            {
              reads: [CourseEnrolmentsView],
              parse: (request) => Effect.succeed(request.params)
            },
            (params) =>
              Effect.gen(function* () {
                const sql = yield* SqlClient.SqlClient;
                const rows = yield* listEnrolments(sql)({ courseId: params.courseId }).pipe(Effect.orDie);
                return { courseId: params.courseId, students: rows.map((row) => ({ studentId: row.student_id, seatNumber: row.seat_number })) };
              })
          )
        )
        .handle(
          "getCourse",
          consistentRead(
            {
              reads: [CourseSeatsView],
              parse: (request) => Effect.succeed(request.params)
            },
            (params) =>
              Effect.gen(function* () {
                const sql = yield* SqlClient.SqlClient;
                const found = yield* findSeats(sql)({ courseId: params.courseId }).pipe(Effect.orDie);
                const row = Option.getOrUndefined(found);
                if (!row) return yield* Effect.fail(problemOf(new CourseNotFound({ courseId: params.courseId })));
                return { courseId: row.course_id, capacity: row.capacity, subscribers: row.subscribers, seatsLeft: row.capacity - row.subscribers };
              })
          )
        )
    )
  );
