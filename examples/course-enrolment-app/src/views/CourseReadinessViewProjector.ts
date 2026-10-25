import { defineView } from "@crablet/views/ProjectedView";
import { integer, text, viewTable } from "@crablet/views/ViewTable";
import { CourseCancelled, StudentSubscribed, SubscriptionReleased } from "../domain/Enrolment.ts";
import { CourseConfirmed, RoomBooked, TeacherAssigned } from "../domain/CourseStart.ts";

export const COURSE_READINESS_VIEW = "course-readiness-view";

// #region view
// The table, as the migration (db/migration/V103) made it; `checkViewTables` compares the two (test/integration/course-seats-table.test.ts).
export const courseReadinessTable = viewTable("course_readiness_view", {
  key: { course_id: text() },
  columns: { teacher_id: text().nullable(), room: text().nullable(), students: integer().default(0), status: text().default("waiting") }
});

// The row is the partial group: each event fills in its own column, so the rows are the same whatever order the events are delivered in.
// What is still missing is a query (`WHERE teacher_id IS NULL OR room IS NULL ...`); `status` changes only on the aggregate itself.
export const CourseReadinessView = defineView(COURSE_READINESS_VIEW, { tables: [courseReadinessTable] })
  .on(TeacherAssigned, (d) => courseReadinessTable.upsert({ course_id: d.courseId }, { set: { teacher_id: d.teacherId } }))
  .on(RoomBooked, (d) => courseReadinessTable.upsert({ course_id: d.courseId }, { set: { room: d.room } }))
  .on(StudentSubscribed, (d) => courseReadinessTable.upsert({ course_id: d.courseId }, { add: { students: 1 } }))
  .on(SubscriptionReleased, (d) => courseReadinessTable.upsert({ course_id: d.courseId }, { add: { students: -1 } }))
  .on(CourseConfirmed, (d) => courseReadinessTable.upsert({ course_id: d.courseId }, { set: { status: "confirmed" } }))
  .on(CourseCancelled, (d) => courseReadinessTable.upsert({ course_id: d.courseId }, { set: { status: "cancelled" } }));
// #endregion view
