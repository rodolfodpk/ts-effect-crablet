// The final two-rule domain (src/domain/Enrolment.ts) in memory: no Docker.
import { describe, expect, test } from "bun:test";
import { Duplicate } from "@crablet/eventstore/AppendErrors";
import { InvalidInput } from "@crablet/commands/Errors";
import { given } from "@crablet/commands/testing/Scenario";
import { CourseFull, CourseNotFound, DefineCourse, StudentAtLimit, Subscribe } from "../src/domain/Enrolment.ts";

const define = (courseId: string, capacity: number) => ({ courseId, capacity });
const sub = (studentId: string, courseId: string) => ({ studentId, courseId });

describe("define_course", () => {
  test("defines a course; defining it twice is a conflict (Duplicate), not a silent no-op", async () => {
    const s = given();
    const first = await s.when(DefineCourse, define("math", 30));
    expect(first.outcome).toBe("created");
    expect(first.events.map((e) => e.type)).toEqual(["CourseDefined"]);
    expect((await s.when(DefineCourse, define("math", 30))).error).toBeInstanceOf(Duplicate);
  });

  test("a capacity below 1 is invalid input", async () => {
    expect((await given().when(DefineCourse, define("math", 0))).error).toBeInstanceOf(InvalidInput);
    expect((await given().when(DefineCourse, { courseId: "math", capacity: 2.5 })).error).toBeInstanceOf(InvalidInput);
  });
});

describe("subscribe: two rules, one decision", () => {
  test("rule 1: a course holds at most `capacity` students (other students' subscriptions count)", async () => {
    const s = given();
    await s.when(DefineCourse, define("math", 2));
    await s.when(Subscribe, sub("ann", "math"));
    await s.when(Subscribe, sub("bob", "math"));
    const refused = await s.when(Subscribe, sub("cy", "math"));
    expect(refused.error).toBeInstanceOf(CourseFull);
    expect((refused.error as CourseFull).capacity).toBe(2);
  });

  test("rule 2: a student takes at most 3 courses (subscriptions to OTHER courses count)", async () => {
    const s = given();
    for (const c of ["a", "b", "c", "d"]) await s.when(DefineCourse, define(c, 10));
    for (const c of ["a", "b", "c"]) expect((await s.when(Subscribe, sub("ann", c))).outcome).toBe("created");
    const refused = await s.when(Subscribe, sub("ann", "d"));
    expect(refused.error).toBeInstanceOf(StudentAtLimit);
    expect((refused.error as StudentAtLimit).limit).toBe(3);
    expect((await s.when(Subscribe, sub("bob", "d"))).outcome).toBe("created"); // someone else is unaffected
  });

  test("an unknown course is refused; subscribing twice is 'already done' and writes nothing", async () => {
    const s = given();
    await s.when(DefineCourse, define("math", 5));
    expect((await s.when(Subscribe, sub("ann", "ghost"))).error).toBeInstanceOf(CourseNotFound);
    await s.when(Subscribe, sub("ann", "math"));
    const again = await s.when(Subscribe, sub("ann", "math"));
    expect(again.outcome).toBe("idempotent");
    expect(again.reason).toBe("ALREADY_SUBSCRIBED");
    expect(s.log.filter((e) => e.type === "StudentSubscribed")).toHaveLength(1);
  });

  test("a full course does not count a student's repeat as a new subscriber (the repeat is checked first)", async () => {
    const s = given();
    await s.when(DefineCourse, define("math", 1));
    await s.when(Subscribe, sub("ann", "math"));
    expect((await s.when(Subscribe, sub("ann", "math"))).outcome).toBe("idempotent"); // not CourseFull
  });
});
