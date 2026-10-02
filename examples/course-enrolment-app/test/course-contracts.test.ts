// The course app's commands are built from its contracts (the server checks this when it starts; this pins it without a server),
// and the contracts are the public part: the same names, input Schemas and errors the commands carry.
import { describe, expect, test } from "bun:test";
import { checkImplementations } from "@crablet/commands-http";
import { courseContracts } from "../src/CourseApi.ts";
import { DefineCourse, Subscribe } from "../src/domain/Enrolment.ts";
import { CourseFull, CourseNotFound, DefineCourseContract, StudentAtLimit, SubscribeContract } from "../src/domain/enrolment.contract.ts";

describe("course contracts", () => {
  test("every contract has its command, built from it", () => {
    expect(() => checkImplementations(courseContracts, { define_course: DefineCourse, subscribe: Subscribe })).not.toThrow();
  });

  test("the API is declared from exactly these two contracts", () => {
    expect(courseContracts).toEqual([DefineCourseContract, SubscribeContract]);
    expect(courseContracts.map((c) => c.name)).toEqual(["define_course", "subscribe"]);
  });

  test("subscribe declares the three domain errors it can fail with; define_course declares none", () => {
    expect(SubscribeContract.errors).toEqual([CourseNotFound, CourseFull, StudentAtLimit]);
    expect(DefineCourseContract.errors).toEqual([]);
  });

  test("a command and its contract share their name, input and errors", () => {
    for (const [contract, command] of [[DefineCourseContract, DefineCourse], [SubscribeContract, Subscribe]] as const) {
      expect(command.name).toBe(contract.name);
      expect(command.input).toBe(contract.input);
      expect(command.errors).toBe(contract.errors);
    }
  });
});
