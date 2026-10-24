import { defineAutomation } from "@crablet/automations/AutomationHandler";
import { StudentSubscribed } from "../domain/Enrolment.ts";
import { ConfirmCourse, RoomBooked, TeacherAssigned } from "../domain/CourseStart.ts";

// #region automation
// Every event that could complete a course asks ConfirmCourse to look. The handler only names the course (the correlation); whether the
// course is complete is decided by the command, on the log, so the order the events are delivered in does not matter.
export const confirmCourseWhenReady = defineAutomation("confirm-course-when-ready", ConfirmCourse)
  .on(TeacherAssigned, (d) => ({ courseId: d.courseId }))
  .on(RoomBooked, (d) => ({ courseId: d.courseId }))
  .on(StudentSubscribed, (d) => ({ courseId: d.courseId }));
// #endregion automation
