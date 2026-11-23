import { describe, expect, test } from "bun:test";
import { isDomainProblem, matchDomainProblem } from "../src/ClientErrors.ts";

const full = { errorType: "CourseFull", detail: "full", fields: { courseId: "c1", capacity: 3 } } as const;
const notFound = { errorType: "CourseNotFound", detail: "none", fields: { courseId: "c9" } } as const;
const rejected = { title: "Bad Request", detail: "capacity" };
type CallError = typeof full | typeof notFound | typeof rejected | Error;

const meaning = (error: CallError): string =>
  matchDomainProblem(
    error,
    { CourseFull: ({ fields }) => `full:${fields.capacity}`, CourseNotFound: ({ fields }) => `none:${fields.courseId}` },
    (other) => (other instanceof Error ? `error:${other.message}` : `rejected:${other.title}`)
  );

describe("reading what a typed client fails with", () => {
  test("a domain error goes to its own handler, with its fields", () => {
    expect(meaning(full)).toBe("full:3");
    expect(meaning(notFound)).toBe("none:c9");
  });

  test("anything else goes to `otherwise`", () => {
    expect(meaning(rejected)).toBe("rejected:Bad Request");
    expect(meaning(new Error("down"))).toBe("error:down");
  });

  test("a problem the page does not know (a server newer than the page) is handled as any other error, not thrown", () => {
    // type escape: a problem the compiler does not know is exactly what this test builds
    const newer = { errorType: "CourseArchived", detail: "x", fields: {} } as unknown as CallError;
    expect(meaning(newer)).toBe("rejected:undefined");
  });

  test("the guard accepts an object with a string errorType, and nothing else", () => {
    expect(isDomainProblem(full)).toBe(true);
    for (const not of [null, undefined, "CourseFull", 7, {}, { errorType: 1 }, rejected, new Error("x")]) expect(isDomainProblem(not)).toBe(false);
  });
});
