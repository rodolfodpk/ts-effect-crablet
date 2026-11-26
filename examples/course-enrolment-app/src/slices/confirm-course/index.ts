// The confirm-course slice: a course is confirmed once it has a teacher, a room and enough students, and cancelled when its readiness period ends
// first (the EIP Aggregator, docs/guides/build/aggregate-events.md). The automation and the readiness view are defined and tested here; the app does
// not run them yet.
import { CancelUnreadyCourse } from "./CourseStart.ts";

export * from "./CourseStart.ts";
export * from "./ConfirmCourseAutomation.ts";
export * from "./CourseReadinessViewProjector.ts";

// What the deadlines module runs for this slice (processes.ts): the cancellation DefineCourse sets.
export const confirmCourseDeadlineCommands = [CancelUnreadyCourse] as const;
