// TUTORIAL STEP 1 - in memory, no Docker, no database. Run it:   bun test examples/course-enrolment-app/tutorial/step1-capacity-only.test.ts
//
// One rule only: a course holds at most `capacity` students. Everything here is defined in this file so you can read
// it top to bottom; the full two-rule domain (src/domain/Enrolment.ts) is step 2.
import { describe, expect, test } from "bun:test";
import * as Schema from "effect/Schema";
import { defineCommand, emit, fail, noop } from "@crablet/commands/Command";
import { DomainError } from "@crablet/commands/Errors";
import { defineEvent } from "@crablet/commands/Event";
import { defineModel } from "@crablet/commands/Model";
import { given } from "@crablet/commands/testing/Scenario";

// #region step1-domain
// 1. Events: a name, a payload, and the tags an event can be found by. There are no streams.
const CourseDefined = defineEvent("CourseDefined", {
  schema: Schema.Struct({ courseId: Schema.String, capacity: Schema.Int }),
  tags: (d) => ({ course_id: d.courseId })
});
const StudentSubscribed = defineEvent("StudentSubscribed", {
  schema: Schema.Struct({ studentId: Schema.String, courseId: Schema.String }),
  tags: (d) => ({ student_id: d.studentId, course_id: d.courseId })
});

// 2. A model: what the events mean for one course - and, from the same declaration, which events could change that
//    answer (the command's consistency boundary).
const CourseModel = defineModel({ by: "course_id", initial: () => ({ exists: false, capacity: 0, subscribers: 0 }) })
  .on(CourseDefined, (c, d) => ({ ...c, exists: true, capacity: d.capacity }))
  .on(StudentSubscribed, (c) => ({ ...c, subscribers: c.subscribers + 1 }));

class CourseNotFound extends DomainError("CourseNotFound", { fields: { courseId: Schema.String }, kind: "not_found" }) {}
class CourseFull extends DomainError("CourseFull", { fields: { courseId: Schema.String, capacity: Schema.Int }, kind: "conflict" }) {}

// 3. A command: a PURE decision. Nothing here touches a database.
const Subscribe = defineCommand({
  name: "subscribe",
  errors: [CourseNotFound, CourseFull], // the domain errors it can fail with; `decide` may fail with no others
  input: Schema.Struct({ studentId: Schema.String, courseId: Schema.String }),
  model: (c) => CourseModel.of({ id: c.courseId }),
  decide: (course, c) =>
    !course.exists
      ? fail(new CourseNotFound({ courseId: c.courseId }))
      : course.subscribers >= course.capacity
        ? fail(new CourseFull({ courseId: c.courseId, capacity: course.capacity }))
        : emit(StudentSubscribed(c))
});
// #endregion step1-domain

// #region step1-tests
// 4. Test it: given a history, when a command arrives, then ... (the real command pipeline, against an in-memory store).
describe("step 1: a course holds at most `capacity` students", () => {
  test("a student subscribes to a course with a free seat", async () => {
    const scenario = given(CourseDefined({ courseId: "math", capacity: 2 }));
    const result = await scenario.when(Subscribe, { studentId: "ann", courseId: "math" });
    expect(result.outcome).toBe("created");
    expect(result.events.map((e) => e.type)).toEqual(["StudentSubscribed"]);
  });

  test("the last seat goes to whoever asks first; the next student is refused with CourseFull", async () => {
    const scenario = given(CourseDefined({ courseId: "math", capacity: 1 }));
    expect((await scenario.when(Subscribe, { studentId: "ann", courseId: "math" })).outcome).toBe("created");
    const refused = await scenario.when(Subscribe, { studentId: "bob", courseId: "math" });
    expect(refused.error).toBeInstanceOf(CourseFull);
    expect(refused.events).toEqual([]); // nothing was written
  });

  test("an unknown course is refused", async () => {
    const result = await given().when(Subscribe, { studentId: "ann", courseId: "ghost" });
    expect(result.error).toBeInstanceOf(CourseNotFound);
  });
});
// #endregion step1-tests
