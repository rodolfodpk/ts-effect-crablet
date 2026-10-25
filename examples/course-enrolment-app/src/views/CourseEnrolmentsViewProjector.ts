import { Effect } from "effect";
import { defineView } from "@crablet/views/ProjectedView";
import { integer, raw, text, viewTable } from "@crablet/views/ViewTable";
import { CourseCancelled, StudentSubscribed, SubscriptionReleased } from "../domain/Enrolment.ts";

export const COURSE_ENROLMENTS_VIEW = "course-enrolments-view";

// #region hand-written
// The table, as the migration (db/migration/V102) made it, so the drift check covers it (test/integration/course-seats-table.test.ts).
export const courseEnrolmentsTable = viewTable("course_enrolments_view", {
  key: { course_id: text(), student_id: text() },
  columns: { seat_number: integer() }
});

// For what the table operations cannot say, `raw` runs your own SQL: the seat number a student gets is the highest of the course's seat numbers
// PLUS ONE (so a number given back by a release is not given again), computed by the database from the view's own table in the same statement. It runs
// on the `sql` of the view's cursor, so it commits with it (ADR-0023: the batch is applied once even if it is delivered twice); the payload is still read
// through the event's definition, and the view still listens to the event types of its handlers. Nothing checks the SQL text, and `raw` cannot run in
// memory: the integration test (test/integration/course-enrolments-view.test.ts) is what checks it. A release is a table operation (`remove`).
export const CourseEnrolmentsView = defineView(COURSE_ENROLMENTS_VIEW, { tables: [courseEnrolmentsTable] })
  .on(StudentSubscribed, (d) =>
    raw((sql) =>
      Effect.asVoid(
        sql.unsafe(
          `INSERT INTO course_enrolments_view (course_id, student_id, seat_number)
           SELECT $1::text, $2::text, COALESCE(max(seat_number), 0) + 1 FROM course_enrolments_view WHERE course_id = $1
           ON CONFLICT (course_id, student_id) DO NOTHING`,
          [d.courseId, d.studentId]
        )
      )
    )
  )
  .on(SubscriptionReleased, (d) => courseEnrolmentsTable.remove({ course_id: d.courseId, student_id: d.studentId }))
  // One row per student the cancellation was tagged with: a handler may return several operations.
  .on(CourseCancelled, (d) => d.studentIds.map((studentId) => courseEnrolmentsTable.remove({ course_id: d.courseId, student_id: studentId })));
// #endregion hand-written
