import { describe, expect, test } from "bun:test";
import * as Schema from "effect/Schema";
import { HttpApiSchema } from "@effect/platform";
import {
  CommandApiBadRequest,
  CommandConflict,
  CommandApiUnexpectedError,
  CommandApiBadRequestType,
  CommandApiDcbConcurrencyType,
  CommandApiUnexpectedErrorType
} from "../src/ProblemDetail.ts";

// Each variant is a plain Schema.Class (NOT Schema.TaggedError/TaggedClass) - confirmed against a
// real running @effect/platform server (see NOTES.md's Phase 7 write-up) that TaggedError leaks
// an unwanted `_tag` field into the encoded JSON body with no automatic type/title fields, so
// these tests assert the encoded shape is exactly the declared RFC 7807 fields, nothing more.
describe("ProblemDetail variants", () => {
  test("CommandApiBadRequest.of() produces the RFC 7807 shape with no extra fields", () => {
    const problem = CommandApiBadRequest.of("Unknown command type: bogus");
    expect(Schema.encodeSync(CommandApiBadRequest)(problem)).toEqual({
      type: CommandApiBadRequestType,
      title: "Bad Request",
      status: 400,
      detail: "Unknown command type: bogus"
    });
    expect(HttpApiSchema.getStatusError(CommandApiBadRequest)).toBe(400);
  });

  test("CommandConflict.of() carries violationCode/matchingEventsCount/hint", () => {
    const problem = CommandConflict.of("Concurrent lifecycle event detected", "GUARD_VIOLATION", 1);
    expect(Schema.encodeSync(CommandConflict)(problem)).toEqual({
      type: CommandApiDcbConcurrencyType,
      title: "Conflict",
      status: 409,
      detail: "Concurrent lifecycle event detected",
      violationCode: "GUARD_VIOLATION",
      matchingEventsCount: 1,
      hint: "Refresh state and retry the command if it is still valid."
    });
    expect(HttpApiSchema.getStatusError(CommandConflict)).toBe(409);
  });

  test("CommandApiUnexpectedError never echoes the real internal error message", () => {
    const problem = CommandApiUnexpectedError.instance;
    expect(Schema.encodeSync(CommandApiUnexpectedError)(problem)).toEqual({
      type: CommandApiUnexpectedErrorType,
      title: "Internal Server Error",
      status: 500,
      detail: "Unexpected command API error"
    });
    expect(HttpApiSchema.getStatusError(CommandApiUnexpectedError)).toBe(500);
  });

  test("no variant's encoded JSON carries a _tag field", () => {
    const problem = CommandApiBadRequest.of("x");
    expect(Object.keys(Schema.encodeSync(CommandApiBadRequest)(problem))).not.toContain("_tag");
  });
});
