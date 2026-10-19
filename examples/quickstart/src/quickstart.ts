// The README's quick start, runnable: `bun run --cwd examples/quickstart start` (or `node src/quickstart.ts`).
// It runs the real command pipeline against the in-memory store - no database needed - and prints what happened.
// The README shows the region below; `packages/commands/test/guides-sync.test.ts` fails if the two differ.
import { Schema } from "effect";
import { defineEvent } from "@crablet/commands/Event";
import { all, defineModel } from "@crablet/commands/Model";
import { byModel, defineCommand, emit, fail, noop } from "@crablet/commands/Command";
import { DomainError } from "@crablet/commands/Errors";
import { given } from "@crablet/commands/testing/Scenario";

// #region readme
// 1. Events: a name, a payload, and the tags an event can be found by. One fact can be found through two things.
export const CourseDefined = defineEvent("CourseDefined", {
  schema: Schema.Struct({ courseId: Schema.String, capacity: Schema.Int }),
  tags: (d) => ({ course_id: d.courseId })
});
export const StudentSubscribed = defineEvent("StudentSubscribed", {
  schema: Schema.Struct({ studentId: Schema.String, courseId: Schema.String }),
  tags: (d) => ({ student_id: d.studentId, course_id: d.courseId })
});

// 2. Models: what the events mean for one course, and for one student. Each also says which events
//    could change that answer, and that is the consistency boundary.
export const CourseModel = defineModel({ by: "course_id", initial: () => ({ exists: false, capacity: 0, subscribers: 0 }) })
  .on(CourseDefined, (c, d) => ({ ...c, exists: true, capacity: d.capacity }))
  .on(StudentSubscribed, (c) => ({ ...c, subscribers: c.subscribers + 1 }));
export const StudentModel = defineModel({ by: "student_id", initial: () => ({ courses: [] as ReadonlyArray<string> }) })
  .on(StudentSubscribed, (s, d) => ({ courses: [...s.courses, d.courseId] }));

export class CourseNotFound extends DomainError("CourseNotFound", { fields: { courseId: Schema.String }, kind: "not_found" }) {}
export class CourseFull extends DomainError("CourseFull", { fields: { courseId: Schema.String }, kind: "conflict" }) {}
export class StudentAtLimit extends DomainError("StudentAtLimit", { fields: { studentId: Schema.String }, kind: "conflict" }) {}

// 3. A command: a pure decision over BOTH models. Nothing here touches a database.
export const Subscribe = defineCommand({
  name: "subscribe",
  errors: [CourseNotFound, CourseFull, StudentAtLimit], // checked against `decide`, and documented by the REST API
  input: Schema.Struct({ studentId: Schema.String, courseId: Schema.String }),
  model: (c) => all({ course: CourseModel.of({ id: c.courseId }), student: StudentModel.of({ id: c.studentId }) }),
  idempotentBy: byModel(), // the model shows whether it was done; decide answers a repeat
  decide: ({ course, student }, c) =>
    !course.exists
      ? fail(new CourseNotFound({ courseId: c.courseId }))
      : student.courses.includes(c.courseId)
        ? noop("ALREADY_SUBSCRIBED")
        : course.subscribers >= course.capacity
          ? fail(new CourseFull({ courseId: c.courseId }))
          : student.courses.length >= 3
            ? fail(new StudentAtLimit({ studentId: c.studentId }))
            : emit(StudentSubscribed(c))
});
// #endregion readme

/** Runs the scenario and returns the lines it prints (so the test can pin them). */
export const run = async (): Promise<ReadonlyArray<string>> => {
  // A history to start from: math has one seat, the others have ten.
  const scenario = given(
    CourseDefined({ courseId: "math", capacity: 1 }),
    ...["art", "bio", "chem"].map((courseId) => CourseDefined({ courseId, capacity: 10 }))
  );
  const lines: Array<string> = [];
  const show = (r: { outcome: string; events: ReadonlyArray<{ type: string }>; error?: { _tag: string } | undefined }) =>
    r.error ? `failed: ${r.error._tag}` : `${r.outcome}: ${r.events.map((e) => e.type).join(", ") || "nothing appended"}`;
  const subscribe = async (studentId: string, courseId: string) =>
    lines.push(`${`${studentId} -> ${courseId}`.padEnd(12)} ${show(await scenario.when(Subscribe, { studentId, courseId }))}`);

  await subscribe("ann", "math");   // the last seat of math
  await subscribe("bob", "math");   // rule 1: the course is full
  await subscribe("ann", "math");   // a repeat changes nothing
  await subscribe("ann", "art");
  await subscribe("ann", "bio");
  await subscribe("ann", "chem");   // rule 2: a fourth course
  await subscribe("cy", "ghost");   // no such course
  return lines;
};

if (import.meta.main) {
  for (const line of await run()) console.log(line);
}
