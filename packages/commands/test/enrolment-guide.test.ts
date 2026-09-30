// The DCB guide's enrolment example with no database (in-memory store, real command pipeline).
import { describe, expect, test } from "bun:test";
import { given } from "../src/testing/Scenario.ts";
import { CourseDefined, CourseFull, CourseNotFound, StudentAtLimit, StudentSubscribed, Subscribe } from "./support/enrolment.ts";

const course = (courseId: string, capacity: number) => CourseDefined({ courseId, capacity });
const sub = (studentId: string, courseId: string) => ({ studentId, courseId });

describe("subscribe", () => {
  test("subscribes a student; the event is found through both the student and the course", async () => {
    const s = given(course("math", 2));
    const r = await s.when(Subscribe, sub("ann", "math"));
    expect(r.outcome).toBe("created");
    expect(r.events[0]!.tags.map((t) => `${t.key}=${t.value}`).sort()).toEqual(["course_id=math", "student_id=ann"]);
  });

  test("rule 1: a course holds at most `capacity` students (other students' subscriptions count)", async () => {
    const s = given(course("math", 2));
    await s.when(Subscribe, sub("ann", "math"));
    await s.when(Subscribe, sub("bob", "math"));
    const r = await s.when(Subscribe, sub("cy", "math"));
    expect(r.error).toBeInstanceOf(CourseFull);
    expect(r.events).toEqual([]);
  });

  test("rule 2: a student takes at most 3 courses (subscriptions to OTHER courses count)", async () => {
    const s = given(course("a", 9), course("b", 9), course("c", 9), course("d", 9));
    for (const c of ["a", "b", "c"]) expect((await s.when(Subscribe, sub("ann", c))).outcome).toBe("created");
    expect((await s.when(Subscribe, sub("ann", "d"))).error).toBeInstanceOf(StudentAtLimit);
    // someone else is unaffected
    expect((await s.when(Subscribe, sub("bob", "d"))).outcome).toBe("created");
  });

  test("history given as events works too (a course that is already nearly full)", async () => {
    const s = given(course("math", 1), StudentSubscribed({ studentId: "zed", courseId: "math" }));
    expect((await s.when(Subscribe, sub("ann", "math"))).error).toBeInstanceOf(CourseFull);
  });

  test("an unknown course is refused; subscribing twice is 'already done'", async () => {
    const s = given(course("math", 5));
    expect((await s.when(Subscribe, sub("ann", "ghost"))).error).toBeInstanceOf(CourseNotFound);
    await s.when(Subscribe, sub("ann", "math"));
    const again = await s.when(Subscribe, sub("ann", "math"));
    expect(again.outcome).toBe("idempotent");
    expect(again.reason).toBe("ALREADY_SUBSCRIBED");
    expect(s.log.filter((e) => e.type === "StudentSubscribed")).toHaveLength(1);
  });
});
