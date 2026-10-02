// How the page understands what the server answers. The values below have exactly the types the derived client reports (a
// domain error's problem body; the framework's problem classes; a SchemaError), so a refusal the server adds without the page
// handling it fails to compile in src/api.ts, not here.
import { describe, expect, test } from "bun:test";
import { Schema } from "effect";
import { CommandApiBadRequest, CommandConflict } from "@crablet/commands-http/ProblemDetail";
import { problemFromError, type CallError } from "../src/api.ts";

const body = { type: "urn:crablet:problem:command-api", status: 409, detail: "x" } as const;

describe("problemFromError", () => {
  test("a missing course", () => {
    expect(
      problemFromError({ ...body, title: "Not Found", status: 404, errorType: "CourseNotFound", fields: { courseId: "ghost" } })
    ).toEqual({ _tag: "CourseNotFound", courseId: "ghost" });
  });

  test("a full course carries its capacity", () => {
    expect(problemFromError({ ...body, title: "Conflict", errorType: "CourseFull", fields: { courseId: "math", capacity: 1 } })).toEqual({
      _tag: "CourseFull",
      courseId: "math",
      capacity: 1
    });
  });

  test("a student at the limit carries the limit", () => {
    expect(problemFromError({ ...body, title: "Conflict", errorType: "StudentAtLimit", fields: { studentId: "ann", limit: 3 } })).toEqual({
      _tag: "StudentAtLimit",
      studentId: "ann",
      limit: 3
    });
  });

  test("the framework's own refusals (a course that already exists, a bad input) keep their title and detail", () => {
    expect(problemFromError(CommandConflict.of('Duplicate operation: "define_course" was already done', "IDEMPOTENCY_VIOLATION"))).toEqual({
      _tag: "Rejected",
      title: "Conflict",
      detail: 'Duplicate operation: "define_course" was already done'
    });
    expect(problemFromError(CommandApiBadRequest.of("Invalid payload for command: define_course"))).toEqual({
      _tag: "Rejected",
      title: "Bad Request",
      detail: "Invalid payload for command: define_course"
    });
  });

  test("a 400 that names the failing fields shows them, by path", () => {
    expect(
      problemFromError(
        CommandApiBadRequest.of("Invalid payload for command: define_course", [
          { path: ["capacity"], message: "Expected a value greater than or equal to 1" },
          { path: ["user", "tags", 1], message: "Expected string" }
        ])
      )
    ).toEqual({
      _tag: "Rejected",
      title: "Bad Request",
      detail: "Invalid payload for command: define_course (capacity: Expected a value greater than or equal to 1; user.tags.1: Expected string)"
    });
  });

  test("a request the derived client refuses to send (its Schema is the server's) names the field", () => {
    let error: unknown;
    try {
      Schema.decodeUnknownSync(Schema.Struct({ capacity: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)) }))({ capacity: 0 });
    } catch (e) {
      error = e;
    }
    const problem = problemFromError(error as Schema.SchemaError);
    expect(problem._tag).toBe("Mismatch");
    expect(problem._tag === "Mismatch" && problem.detail).toContain("capacity");
  });

  test("anything else (a network failure) is Unreachable", () => {
    // an HttpClientError in real life; any value that is not one of the cases above lands here
    expect(problemFromError(new Error("fetch failed") as unknown as CallError)).toEqual({ _tag: "Unreachable" });
  });
});
