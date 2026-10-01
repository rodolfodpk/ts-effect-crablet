import * as Schema from "effect/Schema";
import { HttpApiSchema } from "effect/http-api"; // also registers the `httpApiStatus` schema annotation used below
import type { ErrorKind } from "@crablet/commands/Errors";

// RFC 7807 (Problem Details for HTTP APIs) response bodies for the command API.
//
// Deliberately plain Schema.Class, NOT Schema.TaggedError: TaggedError's automatic `_tag` field
// leaks into the encoded JSON body (and no `type`/`title` fields are added for you), so it is not
// RFC 7807-shaped. A plain Schema.Class encodes to exactly its declared fields, nothing more. The
// `httpApiStatus` class annotation sets the real HTTP status line independently of the body shape
// (verified against a running server on Effect 4).
//
// One shared "bad request" shape covers every 400 case (invalid or malformed payload, malformed
// correlation header), plus dedicated shapes for a DCB conflict (409) and the catch-all (500). A
// command's own domain errors each get a response schema of their own (`problemSchemaOf` below).
// Every problem is served as `application/problem+json` (RFC 7807's media type).

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
// the error's KIND decides the HTTP status, with no per-command code needed.
//   not_found -> 404   invalid -> 400   conflict -> 409   forbidden -> 403
// `errorType` is the error's tag, `detail` its message (or the tag when it has none), and `fields` its
// declared fields (RFC 7807 allows extension members).
export const problemStatusOf = { not_found: 404, invalid: 400, conflict: 409, forbidden: 403 } as const;
const problemTitleOf = { not_found: "Not Found", invalid: "Bad Request", conflict: "Conflict", forbidden: "Forbidden" } as const;

export const domainProblemOf = (kind: ErrorKind, error: unknown): object => {
  const tag = (error as { _tag?: string })._tag ?? "DomainError";
  const message = (error as { message?: string }).message;
  const declared = (error as { constructor?: { fields?: Record<string, unknown> } }).constructor?.fields ?? {};
  const fields = Object.fromEntries(Object.keys(declared).map((key) => [key, (error as Record<string, unknown>)[key]]));
  return {
    type: `urn:crablet:problem:command-api:${kind.replace("_", "-")}`,
    title: problemTitleOf[kind],
    status: problemStatusOf[kind],
    detail: message || tag,
    errorType: tag,
    fields
  };
};

// The response schema of ONE declared domain error: exactly what `domainProblemOf` produces for it, with
// the error's own fields typed. Used to document and to encode the response; the API description gets one
// component per error (`<Tag>Problem`). The same class always yields the same schema instance.
export interface DeclaredDomainError {
  readonly kind: ErrorKind;
  readonly tag: string;
  readonly fields: Record<string, Schema.Top>;
}
const problemSchemaCache = new WeakMap<object, Schema.Top>();
export const problemSchemaOf = (error: DeclaredDomainError): Schema.Top => {
  const cached = problemSchemaCache.get(error);
  if (cached !== undefined) return cached;
  const schema = Schema.Struct({
    type: Schema.String,
    title: Schema.Literal(problemTitleOf[error.kind]),
    status: Schema.Literal(problemStatusOf[error.kind]),
    detail: Schema.String,
    errorType: Schema.Literal(error.tag),
    fields: Schema.Struct(error.fields as never)
  })
    .annotate({ httpApiStatus: problemStatusOf[error.kind], identifier: `${error.tag}Problem` } as never)
    .pipe(HttpApiSchema.asJson({ contentType: "application/problem+json" }));
  problemSchemaCache.set(error, schema);
  return schema;
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
