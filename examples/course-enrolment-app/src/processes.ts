import { Effect } from "effect";
import * as Crablet from "@crablet/app";
import * as Views from "@crablet/views";
import type { RunnableView } from "@crablet/views";
import * as Deadlines from "@crablet/deadlines";
import { courseSeatsViews } from "./slices/course-seats/index.ts";
import { courseEnrolmentsViews } from "./slices/course-enrolments/index.ts";
import { paymentsDeadlineCommands } from "./slices/payments/index.ts";
import { confirmCourseDeadlineCommands } from "./slices/confirm-course/index.ts";
import { monthlyFeeDeadlineCommands } from "./slices/monthly-fee/index.ts";

// `viewDelayMs` is a DEMO knob (default 0, off): it holds every batch back that long before the view applies it, so a read made right after a write
// is visibly stale (`?consistency=eventual`) and a read that carries the write's marker has something to wait for. The delay is spent BEFORE the
// projector's transaction opens, so no database transaction sits open while it waits.
export interface CourseModulesOptions {
  readonly viewDelayMs?: number | undefined;
}

const delayedBy = (delayMs: number) => (view: RunnableView): RunnableView =>
  delayMs > 0
    ? { ...view, projector: Effect.map(view.projector, (p) => ({ ...p, handle: (events) => Effect.andThen(Effect.sleep(`${delayMs} millis`), p.handle(events)) })) }
    : view;

// #region course-modules
// The course's two modules, declared once (ADR-0054), from what each slice lists. The views: the seats left (table operations) and who took which
// seat (its own SQL, through `raw`), off the same events. The deadlines (ADR-0043): when a subscription's payment window closes they run the release
// Subscribe set, when a course's readiness period ends the cancellation DefineCourse set, and the monthly fee's invoices and their due dates.
// A new slice is a folder and one entry here. One instance runs each module; the others wait on its lock.
export const courseModules = (options: CourseModulesOptions = {}) =>
  Crablet.modules(Views.module({ views: [...courseSeatsViews, ...courseEnrolmentsViews].map(delayedBy(options.viewDelayMs ?? 0)) }))
    .with(Deadlines.module({ commands: [...paymentsDeadlineCommands, ...confirmCourseDeadlineCommands, ...monthlyFeeDeadlineCommands] }));
// #endregion course-modules
