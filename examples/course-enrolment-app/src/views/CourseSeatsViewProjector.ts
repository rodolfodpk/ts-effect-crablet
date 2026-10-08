import { Effect } from "effect";
import type { SqlClient } from "effect/sql";
import type { SqlError } from "effect/sql/SqlError";
import type { StoredEvent } from "@crablet/eventstore";
import type { EventDecodingError } from "@crablet/eventstore/EventDecoding";
import { makeTransactionalViewProjector, type ViewProjector } from "@crablet/views/ViewProjector";
import { viewSubscriptionOf, type ViewSubscription } from "@crablet/views/ViewSubscription";
import { CourseDefined, StudentSubscribed } from "../domain/Enrolment.ts";
import { COURSE_SEATS_VIEW } from "../CourseApi.ts";

// The name is defined next to the API (CourseApi.ts), which must not import this server-side file.
export { COURSE_SEATS_VIEW };

// What the view listens to: the two event types that change a course's seats.
// #region subscription
export const courseSeatsViewSubscription: ViewSubscription = viewSubscriptionOf(COURSE_SEATS_VIEW, {
  eventTypes: new Set([CourseDefined.type, StudentSubscribed.type])
});
// #endregion subscription

// #region projector
// Seats per course. Each event is applied once even if it is delivered again: the row remembers the position of the
// last event it applied, and an event at or before that position is ignored. That is sound here because the events that
// touch one course are written one after another (their commands share a boundary), so a course's positions only grow;
// for events of unrelated transactions, delivery order is not position order, so key idempotency on the event instead.
//
// `decodeStored` reads the payload through the event's own definition: one this definition cannot read fails the batch with a typed `EventDecodingError`
// (position, type, issues), which the processor records against the view, instead of projecting something wrong. Casting `event.data` would validate nothing.
const handleEvent = (event: StoredEvent, sql: SqlClient.SqlClient): Effect.Effect<void, SqlError | EventDecodingError, never> =>
  Effect.gen(function* () {
    switch (event.type) {
      case CourseDefined.type: {
        const data = yield* CourseDefined.decodeStored(event);
        yield* sql.unsafe(
          `INSERT INTO course_seats_view (course_id, capacity, subscribers, last_position) VALUES ($1, $2, 0, $3)
           ON CONFLICT (course_id) DO NOTHING`,
          [data.courseId, data.capacity, event.position.toString()]
        );
        return;
      }
      case StudentSubscribed.type: {
        const data = yield* StudentSubscribed.decodeStored(event);
        yield* sql.unsafe(
          `UPDATE course_seats_view SET subscribers = subscribers + 1, last_position = $2
           WHERE course_id = $1 AND last_position < $2`,
          [data.courseId, event.position.toString()]
        );
        return;
      }
      default:
        return;
    }
  });

export const makeCourseSeatsViewProjector = (): Effect.Effect<ViewProjector<SqlError | EventDecodingError>, never, SqlClient.SqlClient> =>
  makeTransactionalViewProjector(COURSE_SEATS_VIEW, handleEvent);
// #endregion projector
