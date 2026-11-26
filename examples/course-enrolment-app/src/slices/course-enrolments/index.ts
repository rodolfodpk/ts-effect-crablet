// The course-enrolments slice: who took which seat, a view with its own SQL (`raw`).
import { CourseEnrolmentsView } from "./CourseEnrolmentsViewProjector.ts";

export * from "./CourseEnrolmentsViewProjector.ts";

// What the views module runs for this slice (processes.ts).
export const courseEnrolmentsViews = [CourseEnrolmentsView];
