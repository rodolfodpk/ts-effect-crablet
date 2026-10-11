import { Effect } from "effect";
import type { SqlClient } from "effect/sql";
import type { SqlError } from "effect/sql/SqlError";
import type { StoredEvent } from "@crablet/eventstore";
import type { EventDecodingError } from "@crablet/eventstore/EventDecoding";
import { makeTransactionalViewProjector, type ViewProjector } from "@crablet/views/ViewProjector";
import { CourseDefined, StudentSubscribed } from "../domain/Enrolment.ts";
import { COURSE_SEATS_VIEW } from "../CourseApi.ts";
import { qb, run } from "./queryBuilder.ts";

// The same projector as CourseSeatsViewProjector.ts, with the SQL built by Kysely: a misspelled column, a column of another type or a value in the wrong place is a compile error, not a failure at the first event.
// It listens to the same events (use `courseSeatsViewSubscription` from the other file) and writes the same table, so use ONE of the two, not both.
// #region kysely-projector
const handleEvent = (event: StoredEvent, sql: SqlClient.SqlClient): Effect.Effect<void, SqlError | EventDecodingError, never> =>
  Effect.gen(function* () {
    switch (event.type) {
      case CourseDefined.type: {
        const data = yield* CourseDefined.decodeStored(event);
        yield* run(sql,
          qb.insertInto("course_seats_view")
            .values({ course_id: data.courseId, capacity: data.capacity, subscribers: 0, last_position: event.position })
            .onConflict((oc) => oc.column("course_id").doNothing())
        );
        return;
      }
      case StudentSubscribed.type: {
        const data = yield* StudentSubscribed.decodeStored(event);
        yield* run(sql,
          qb.updateTable("course_seats_view")
            .set((eb) => ({ subscribers: eb("subscribers", "+", 1), last_position: event.position }))
            .where("course_id", "=", data.courseId)
            .where("last_position", "<", event.position)
        );
        return;
      }
      default:
        return;
    }
  });

export const makeCourseSeatsViewProjectorKysely = (): Effect.Effect<ViewProjector<SqlError | EventDecodingError>, never, SqlClient.SqlClient> =>
  makeTransactionalViewProjector(COURSE_SEATS_VIEW, handleEvent);
// #endregion kysely-projector
