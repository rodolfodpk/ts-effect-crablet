// How the page understands what the server answers. The bodies below are what the server really sends (the
// CourseNotFound one is copied from a live response; the others are what `domainProblemOf` builds for each kind).
import { describe, expect, test } from "bun:test";
import { Schema } from "effect";
import { problemFromError } from "../src/api.ts";

describe("problemFromError", () => {
  test("a missing course", () => {
    const body = {
      type: "urn:crablet:problem:command-api:not-found",
      title: "Not Found",
      status: 404,
      detail: "CourseNotFound",
      errorType: "CourseNotFound",
      fields: { courseId: "ghost" }
    };
    expect(problemFromError(body)).toEqual({ _tag: "CourseNotFound", courseId: "ghost" });
  });

  test("a full course carries its capacity", () => {
    const body = { title: "Conflict", status: 409, detail: "CourseFull", errorType: "CourseFull", fields: { courseId: "math", capacity: 1 } };
    expect(problemFromError(body)).toEqual({ _tag: "CourseFull", courseId: "math", capacity: 1 });
  });

  test("a student at the limit carries the limit", () => {
    const body = { title: "Conflict", status: 409, detail: "StudentAtLimit", errorType: "StudentAtLimit", fields: { studentId: "ann", limit: 3 } };
    expect(problemFromError(body)).toEqual({ _tag: "StudentAtLimit", studentId: "ann", limit: 3 });
  });

  test("the framework's own refusals (a bad input, a course that already exists) keep their title and detail", () => {
    expect(problemFromError({ type: "urn:x", title: "Conflict", status: 409, detail: "duplicate operation detected" })).toEqual({
      _tag: "Rejected",
      title: "Conflict",
      detail: "duplicate operation detected"
    });
    expect(problemFromError({ title: "Bad Request", status: 400, detail: "capacity: Expected a value greater than or equal to 1" })).toEqual({
      _tag: "Rejected",
      title: "Bad Request",
      detail: "capacity: Expected a value greater than or equal to 1"
    });
  });

  test("a body that names a known error but with the wrong fields is not trusted as that error", () => {
    const body = { title: "Conflict", detail: "CourseFull", errorType: "CourseFull", fields: { courseId: "math", capacity: "lots" } };
    expect(problemFromError(body)._tag).toBe("Rejected");
  });

  test("a request the derived client refuses to send (its Schema is the server's) names the field", () => {
    let error: unknown;
    try {
      Schema.decodeUnknownSync(Schema.Struct({ capacity: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)) }))({ capacity: 0 });
    } catch (e) {
      error = e;
    }
    const problem = problemFromError(error);
    expect(problem._tag).toBe("Mismatch");
    expect(problem._tag === "Mismatch" && problem.detail).toContain("capacity");
  });

  test("anything else (a network failure, garbage) is Unreachable", () => {
    expect(problemFromError(new Error("fetch failed"))).toEqual({ _tag: "Unreachable" });
    expect(problemFromError(undefined)).toEqual({ _tag: "Unreachable" });
    expect(problemFromError("nope")).toEqual({ _tag: "Unreachable" });
  });
});
