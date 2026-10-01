import { Effect } from "effect";
import type { SqlClient } from "effect/sql";
import type { SqlError } from "effect/sql/SqlError";
import type { StoredEvent } from "@crablet/eventstore";
import { makeTransactionalViewProjector, type ViewProjector } from "@crablet/views/ViewProjector";
import { viewSubscriptionOf, type ViewSubscription } from "@crablet/views/ViewSubscription";
import { CourseDefined, StudentSubscribed } from "../domain/Enrolment.ts";

export const COURSE_SEATS_VIEW = "course-seats-view";

// What the view listens to: the two event types that change a course's seats.
export const courseSeatsViewSubscription: ViewSubscription = viewSubscriptionOf(COURSE_SEATS_VIEW, {
  eventTypes: new Set([CourseDefined.type, StudentSubscribed.type])
});

// #region projector
// Seats per course. Each event is applied once even if it is delivered again: the row remembers the position of the
// last event it applied, and an event at or before that position is ignored. That is sound here because the events that
// touch one course are written one after another (their commands share a boundary), so a course's positions only grow;
// for events of unrelated transactions, delivery order is not position order, so key idempotency on the event instead.
const handleEvent = (event: StoredEvent, sql: SqlClient.SqlClient): Effect.Effect<void, SqlError, never> => {
  switch (event.type) {
    case CourseDefined.type: {
      const data = CourseDefined.decode(event.data);
      return Effect.asVoid(
        sql.unsafe(
          `INSERT INTO course_seats_view (course_id, capacity, subscribers, last_position) VALUES ($1, $2, 0, $3)
           ON CONFLICT (course_id) DO NOTHING`,
          [data.courseId, data.capacity, event.position.toString()]
        )
      );
    }
    case StudentSubscribed.type: {
      const data = StudentSubscribed.decode(event.data);
      return Effect.asVoid(
        sql.unsafe(
          `UPDATE course_seats_view SET subscribers = subscribers + 1, last_position = $2
           WHERE course_id = $1 AND last_position < $2`,
          [data.courseId, event.position.toString()]
        )
      );
    }
    default:
      return Effect.void;
  }
};

export const makeCourseSeatsViewProjector = (): Effect.Effect<ViewProjector<SqlError>, never, SqlClient.SqlClient> =>
  makeTransactionalViewProjector(COURSE_SEATS_VIEW, handleEvent);
// #endregion projector
