import * as Schema from "effect/Schema";
import "effect/http-api"; // registers the `httpApiStatus` schema annotation used below

// RFC 7807 (Problem Details for HTTP APIs) response bodies for the command API.
//
// Deliberately plain Schema.Class, NOT Schema.TaggedError: TaggedError's automatic `_tag` field
// leaks into the encoded JSON body (and no `type`/`title` fields are added for you), so it is not
// RFC 7807-shaped. A plain Schema.Class encodes to exactly its declared fields, nothing more. The
// `httpApiStatus` class annotation sets the real HTTP status line independently of the body shape
// (verified against a running server on Effect 4).
//
// One shared "bad request" shape covers every 400 case (unknown commandType, invalid payload for a
// known type, malformed correlation header), plus dedicated shapes for a DCB conflict (409) and the
// catch-all (500). Malformed-JSON request bodies never reach the handler at all - the HttpApi
// payload decoder answers 400 with an empty body first - so there is deliberately no
// "malformed JSON" variant here; reshaping that framework default into this RFC 7807 shape is a
// documented follow-up, not implemented.

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
  { httpApiStatus: 400 }
) {
  static of(detail: string): CommandApiBadRequest {
    return new CommandApiBadRequest({ type: CommandApiBadRequestType, title: "Bad Request", status: 400, detail });
  }
}

// Wraps eventstore's Conflict/Duplicate errors - see CommandApiLive.ts for the
// translation. Extra RFC 7807 fields: violationCode, matchingEventsCount, hint.
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
  { httpApiStatus: 409 }
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
  { httpApiStatus: 500 }
) {
  static readonly instance = new CommandApiUnexpectedError({
    type: CommandApiUnexpectedErrorType,
    title: "Internal Server Error",
    status: 500,
    detail: "Unexpected command API error"
  });
}
