// The confirm-course slice: a course is confirmed once it has a teacher, a room and enough students, and cancelled when its readiness period ends
// first (the EIP Aggregator, docs/guides/build/aggregate-events.md). The automation and the readiness view are examples, defined and tested here,
// and the app does not run them: its API has no command that assigns a teacher or books a room, so the automation would never have a course to confirm.
import { CancelUnreadyCourse } from "./CourseStart.ts";

export * from "./CourseStart.ts";
export * from "./ConfirmCourseAutomation.ts";
export * from "./CourseReadinessViewProjector.ts";

// What the deadlines module runs for this slice (processes.ts): the cancellation DefineCourse sets.
export const confirmCourseDeadlineCommands = [CancelUnreadyCourse] as const;
