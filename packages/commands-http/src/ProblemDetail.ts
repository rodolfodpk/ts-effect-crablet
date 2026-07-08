import * as Schema from "effect/Schema";
import { HttpApiSchema } from "@effect/platform";

// Port of com.crablet.command.web.internal.CommandApiProblemTypes + CommandApiExceptionHandler -
// RFC 7807 (Problem Details for HTTP APIs) response bodies.
//
// Deliberately plain Schema.Class, NOT Schema.TaggedError/Schema.TaggedClass: spiked against a
// real running @effect/platform server before writing this file (see NOTES.md's Phase 7 write-up)
// and confirmed Schema.TaggedError's automatic `_tag` field leaks into the encoded JSON body, with
// no `type`/`title` fields added automatically either - not RFC 7807-shaped at all. Plain
// Schema.Class encodes to exactly its declared fields, nothing more. Each class still carries
// `HttpApiSchema.annotations({status})`, which IS honored for the real HTTP status line
// (confirmed by the same spike) independently of the body shape.
//
// Mirrors Java's exception-to-response mapping table for the cases this port's handler actually
// constructs: one shared "bad request" shape for every 400 case (unknown commandType, invalid
// payload for a known type, malformed correlation header) - Java itself uses one
// CommandApiBadRequestException for all of these - plus dedicated shapes for DCB conflict (409)
// and the catch-all (500). Malformed-JSON request bodies never reach the handler at all -
// @effect/platform's own payload-decode failure returns a 400 before CommandApiLive.ts runs
// (confirmed empirically: correct status, empty body) - so there is deliberately no
// CommandApiMalformedJson variant constructed anywhere; reshaping that framework-default response
// to this port's RFC 7807 shape is a documented follow-up, not implemented here (see NOTES.md's
// Phase 7 write-up).

export const CommandApiBadRequestType = "urn:crablet:problem:command-api:bad-request";
export const CommandApiDcbConcurrencyType = "urn:crablet:problem:command-api:dcb-concurrency";
export const CommandApiUnexpectedErrorType = "urn:crablet:problem:command-api:unexpected-error";

export class CommandApiBadRequest extends Schema.Class<CommandApiBadRequest>("CommandApiBadRequest")(
  {
    type: Schema.Literal(CommandApiBadRequestType),
    title: Schema.Literal("Bad Request"),
    status: Schema.Literal(400),
    detail: Schema.String
  },
  HttpApiSchema.annotations({ status: 400 })
) {
  static of(detail: string): CommandApiBadRequest {
    return new CommandApiBadRequest({ type: CommandApiBadRequestType, title: "Bad Request", status: 400, detail });
  }
}

// Wraps eventstore's ConcurrencyException/DCBViolation - see CommandApiLive.ts for the
// translation. Fields mirror Java's ProblemDetail enrichment (violationCode/matchingEventsCount/
// hint) exactly.
export class CommandConflict extends Schema.Class<CommandConflict>("CommandConflict")(
  {
    type: Schema.Literal(CommandApiDcbConcurrencyType),
    title: Schema.Literal("Conflict"),
    status: Schema.Literal(409),
    detail: Schema.String,
    violationCode: Schema.String,
    matchingEventsCount: Schema.Number,
    hint: Schema.Literal("Refresh state and retry the command if it is still valid.")
  },
  HttpApiSchema.annotations({ status: 409 })
) {
  static of(detail: string, violationCode: string, matchingEventsCount: number): CommandConflict {
    return new CommandConflict({
      type: CommandApiDcbConcurrencyType,
      title: "Conflict",
      status: 409,
      detail,
      violationCode,
      matchingEventsCount,
      hint: "Refresh state and retry the command if it is still valid."
    });
  }
}

// Catch-all - detail is always this fixed generic string, never the real internal error message,
// matching Java's explicit "message is not echoed" behavior for unexpected failures.
export class CommandApiUnexpectedError extends Schema.Class<CommandApiUnexpectedError>(
  "CommandApiUnexpectedError"
)(
  {
    type: Schema.Literal(CommandApiUnexpectedErrorType),
    title: Schema.Literal("Internal Server Error"),
    status: Schema.Literal(500),
    detail: Schema.Literal("Unexpected command API error")
  },
  HttpApiSchema.annotations({ status: 500 })
) {
  static readonly instance = new CommandApiUnexpectedError({
    type: CommandApiUnexpectedErrorType,
    title: "Internal Server Error",
    status: 500,
    detail: "Unexpected command API error"
  });
}
