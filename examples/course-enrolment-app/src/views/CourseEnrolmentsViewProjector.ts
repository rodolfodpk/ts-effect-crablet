import { Effect } from "effect";
import type { SqlClient } from "effect/sql";
import type { SqlError } from "effect/sql/SqlError";
import type { StoredEvent } from "@crablet/eventstore";
import type { EventDecodingError } from "@crablet/eventstore/EventDecoding";
import { makeTransactionalViewProjector, type ViewProjector } from "@crablet/views/ViewProjector";
import { viewSubscriptionOf, type ViewSubscription } from "@crablet/views/ViewSubscription";
import { StudentSubscribed } from "../domain/Enrolment.ts";

export const COURSE_ENROLMENTS_VIEW = "course-enrolments-view";

// #region hand-written
// A hand-written projector, for what `defineView`'s operations cannot say: the seat number a student gets is the count of the course's rows PLUS ONE, computed by the database from the view's own table in the
// same statement. You write the three things the framework would otherwise do: read the payload through the event's definition (`decodeStored`: an unreadable event fails the batch with a typed `EventDecodingError`),
// run the SQL on the `sql` you are given (so it commits with the view's cursor, ADR-0023: the batch is applied once even if it is delivered twice), and say which events you want (the subscription below).
// Nothing checks the SQL text; the integration test (test/integration/course-enrolments-view.test.ts) is what does.
const handleEvent = (event: StoredEvent, sql: SqlClient.SqlClient): Effect.Effect<void, SqlError | EventDecodingError, never> =>
  Effect.gen(function* () {
    if (event.type !== StudentSubscribed.type) return;
    const data = yield* StudentSubscribed.decodeStored(event);
    yield* sql.unsafe(
      `INSERT INTO course_enrolments_view (course_id, student_id, seat_number)
       SELECT $1::text, $2::text, count(*) + 1 FROM course_enrolments_view WHERE course_id = $1
       ON CONFLICT (course_id, student_id) DO NOTHING`,
      [data.courseId, data.studentId]
    );
  });

export const makeCourseEnrolmentsViewProjector = (): Effect.Effect<ViewProjector<SqlError | EventDecodingError>, never, SqlClient.SqlClient> =>
  makeTransactionalViewProjector(COURSE_ENROLMENTS_VIEW, handleEvent);

export const courseEnrolmentsViewSubscription: ViewSubscription = viewSubscriptionOf(COURSE_ENROLMENTS_VIEW, {
  eventTypes: new Set([StudentSubscribed.type])
});
// #endregion hand-written
