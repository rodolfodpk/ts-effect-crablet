// The course-seats slice: the seats left per course, the view the course reads and the live feed use (src/api).
import { CourseSeatsView } from "./CourseSeatsViewProjector.ts";

export * from "./CourseSeatsViewProjector.ts";

// What the views module runs for this slice (processes.ts).
export const courseSeatsViews = [CourseSeatsView];
