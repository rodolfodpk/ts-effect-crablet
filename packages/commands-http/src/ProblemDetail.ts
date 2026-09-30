import * as Schema from "effect/Schema";
import "effect/http-api"; // registers the `httpApiStatus` schema annotation used below
import type { ErrorKind } from "@crablet/commands/Errors";

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

// A refused append: the command's decision went stale (`Conflict`, after its retries ran out) or it
// repeated an operation it declared must fail (`Duplicate`). See CommandApiLive.ts for the translation.
// `violationCode` says which check refused it: DCB_VIOLATION (the decision model changed),
// GUARD_VIOLATION (a lifecycle guard changed) or IDEMPOTENCY_VIOLATION (already done).
export class CommandConflict extends Schema.Class<CommandConflict>("CommandConflict")(
  {
    type: Schema.Literal(CommandApiDcbConcurrencyType),
    title: Schema.Literal("Conflict"),
    status: Schema.Literal(409),
    detail: Schema.String,
    violationCode: Schema.String,
    hint: Schema.Literal("Refresh state and retry the command if it is still valid.")
  },
  { httpApiStatus: 409 }
) {
  static of(detail: string, violationCode: string): CommandConflict {
    return new CommandConflict({
      type: CommandApiDcbConcurrencyType,
      title: "Conflict",
      status: 409,
      detail,
      violationCode,
      hint: "Refresh state and retry the command if it is still valid."
    });
  }
}

// A command's own domain error (a `DomainError`, see @crablet/commands/Errors) presented generically:
// the error's KIND decides the HTTP status, with no per-command hook needed.
//   not_found -> 404   invalid -> 400   conflict -> 409   forbidden -> 403
// `errorType` is the error's tag, `detail` its message (or the tag when it has none), and `fields` its
// declared fields (RFC 7807 allows extension members). A command that wants a richer or differently
// shaped response supplies its own `mapError` hook (see ExposedCommand.ts), which takes precedence.
const domainProblemFields = {
  type: Schema.String,
  detail: Schema.String,
  errorType: Schema.String,
  fields: Schema.Record(Schema.String, Schema.Unknown)
};

export class CommandApiNotFound extends Schema.Class<CommandApiNotFound>("CommandApiNotFound")(
  { ...domainProblemFields, title: Schema.Literal("Not Found"), status: Schema.Literal(404) },
  { httpApiStatus: 404 }
) {}
export class CommandApiInvalid extends Schema.Class<CommandApiInvalid>("CommandApiInvalid")(
  { ...domainProblemFields, title: Schema.Literal("Bad Request"), status: Schema.Literal(400) },
  { httpApiStatus: 400 }
) {}
export class CommandApiDomainConflict extends Schema.Class<CommandApiDomainConflict>("CommandApiDomainConflict")(
  { ...domainProblemFields, title: Schema.Literal("Conflict"), status: Schema.Literal(409) },
  { httpApiStatus: 409 }
) {}
export class CommandApiForbidden extends Schema.Class<CommandApiForbidden>("CommandApiForbidden")(
  { ...domainProblemFields, title: Schema.Literal("Forbidden"), status: Schema.Literal(403) },
  { httpApiStatus: 403 }
) {}

export const domainProblemOf = (kind: ErrorKind, error: unknown): object => {
  const tag = (error as { _tag?: string })._tag ?? "DomainError";
  const message = (error as { message?: string }).message;
  const declared = (error as { constructor?: { fields?: Record<string, unknown> } }).constructor?.fields ?? {};
  const fields = Object.fromEntries(Object.keys(declared).map((key) => [key, (error as Record<string, unknown>)[key]]));
  const common = { type: `urn:crablet:problem:command-api:${kind.replace("_", "-")}`, detail: message || tag, errorType: tag, fields };
  switch (kind) {
    case "not_found":
      return new CommandApiNotFound({ ...common, title: "Not Found", status: 404 });
    case "invalid":
      return new CommandApiInvalid({ ...common, title: "Bad Request", status: 400 });
    case "conflict":
      return new CommandApiDomainConflict({ ...common, title: "Conflict", status: 409 });
    case "forbidden":
      return new CommandApiForbidden({ ...common, title: "Forbidden", status: 403 });
  }
};

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
