import { defineView } from "@crablet/views/ProjectedView";
import { integer, text, viewTable } from "@crablet/views/ViewTable";
import { CourseDefined, StudentSubscribed } from "../domain/Enrolment.ts";
import { COURSE_SEATS_VIEW } from "../CourseApi.ts";

// The name is defined next to the API (CourseApi.ts), which must not import this server-side file.
export { COURSE_SEATS_VIEW };

// #region projector
// The table, as the migration (db/migration/V100, V101) made it. `checkViewTables` compares this declaration with the migrated database (test/integration/course-seats-table.test.ts), so a column a migration renames fails a test.
export const courseSeatsTable = viewTable("course_seats_view", {
  key: { course_id: text() },
  columns: { capacity: integer(), subscribers: integer().default(0) }
});

// Seats per course: what each event does to the table, and nothing else. The handlers are pure (the decoded event in, operations out); the framework reads each payload through the event's own definition
// (a payload it cannot read fails the batch with a typed `EventDecodingError`, never projected wrongly), runs the operations on the `sql` of the view's cursor, and listens to the event types of the handlers
// below (CourseDefined and StudentSubscribed). `DefineCourse` refuses a second definition, and the insert also keeps the first capacity (`ignore`); a subscription ADDS one, it never copies a total.
// An event delivered twice is applied once, but not here: the batch and the view's cursor commit in one transaction (ADR-0023), so the processor guarantees it.
export const CourseSeatsView = defineView(COURSE_SEATS_VIEW, { tables: [courseSeatsTable] })
  .on(CourseDefined, (d) => courseSeatsTable.insert({ course_id: d.courseId, capacity: d.capacity }, { onConflict: "ignore" }))
  .on(StudentSubscribed, (d) => courseSeatsTable.update({ course_id: d.courseId }, { add: { subscribers: 1 } }));
// #endregion projector
