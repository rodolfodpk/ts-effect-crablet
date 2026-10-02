// The 400 problem: its optional `errors` member (one { path, message } per failed field).
import { describe, expect, test } from "bun:test";
import { Schema } from "effect";
import { CommandApiBadRequest } from "../src/ProblemDetail.ts";

const wire = (problem: CommandApiBadRequest): Record<string, unknown> => Schema.encodeSync(CommandApiBadRequest)(problem) as Record<string, unknown>;

describe("CommandApiBadRequest.errors", () => {
  test("is absent unless there are issues to report", () => {
    expect("errors" in wire(CommandApiBadRequest.of("Invalid payload for command: x"))).toBe(false);
    expect("errors" in wire(CommandApiBadRequest.of("Invalid payload for command: x", []))).toBe(false);
  });

  test("carries the issues: paths (names and array indexes) and messages", () => {
    const body = wire(
      CommandApiBadRequest.of("Invalid payload for command: x", [
        { path: ["user", "tags", 1], message: "Expected string" },
        { path: [], message: "Expected object" }
      ])
    );
    expect(body["errors"]).toEqual([
      { path: ["user", "tags", 1], message: "Expected string" },
      { path: [], message: "Expected object" }
    ]);
    expect(body["status"]).toBe(400);
    expect(body["detail"]).toBe("Invalid payload for command: x");
  });

  test("an older-shaped body (no errors) still decodes: the member is optional", () => {
    const decoded = Schema.decodeUnknownSync(CommandApiBadRequest)({
      type: "urn:crablet:problem:command-api:bad-request",
      title: "Bad Request",
      status: 400,
      detail: "Invalid payload for command: x"
    });
    expect(decoded.errors).toBeUndefined();
  });
});
