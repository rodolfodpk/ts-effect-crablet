import * as Schema from "effect/Schema";
import { HttpApi, HttpApiEndpoint, HttpApiGroup } from "effect/http-api";
import { CommandApiBadRequest, CommandConflict, CommandApiUnexpectedError } from "./ProblemDetail.ts";

// The command API's two routes: GET (list exposed commands) and POST (execute) on the same
// configurable base path. POST's payload is one *static* envelope shape, not a per-command-type
// schema resolved dynamically - an endpoint's payload schema must be known at API-definition
// time. All the "which concrete command is this" polymorphism happens inside CommandApiLive.ts's
// handler body, after decoding this envelope: resolve `commandType`, then decode `command` with
// that entry's own schema.
export const CommandEnvelope = Schema.Struct({
  commandType: Schema.String,
  command: Schema.Unknown
});

export const CommandResultResponse = Schema.Struct({
  status: Schema.Literals(["CREATED", "IDEMPOTENT"]),
  reason: Schema.NullOr(Schema.String)
});

export const ExposedCommandsResponse = Schema.Struct({
  exposedCommands: Schema.Array(Schema.Struct({ commandType: Schema.String }))
});

// `extraErrors`: lets a consuming app (e.g. examples/wallet-example-app) declare its own
// domain-specific error schemas (plain Schema.Class, RFC 7807-shaped like ProblemDetail.ts's three
// built-in ones) on the execute endpoint, so ExposedCommand.ts's per-command `mapError` hook has
// somewhere real to surface them - an endpoint needs every possible error schema declared up front
// to encode and status-code it, not just constructed at runtime.
//
// Exported separately from `makeCommandApi` (which builds a *complete*, standalone `HttpApi`) so a
// bigger app-owned `HttpApi` can `.add()` this group alongside its own groups (e.g. a read-only
// query API) and serve them all from one router.
//
// The execute handler returns a raw HttpServerResponse with a status chosen after the command runs
// (200 idempotent / 201 created); `success` documents the body shape for the OpenAPI/typed-client
// side. Both endpoints share one path (GET/POST, differentiated by method) and `basePath` is a
// runtime-configurable string, hence the plain `(name, path, options)` form.
export const makeCommandApiGroup = (basePath: `/${string}`, extraErrors: ReadonlyArray<Schema.Top> = []) =>
  HttpApiGroup.make("commands")
    .add(HttpApiEndpoint.get("listExposedCommands", basePath, { success: ExposedCommandsResponse }))
    .add(
      HttpApiEndpoint.post("executeCommand", basePath, {
        payload: CommandEnvelope,
        success: CommandResultResponse,
        // The error list is assembled from a runtime-variable-length array, which cannot be tracked
        // statically; the cast is a deliberate, narrow type-erasure at this one composition boundary.
        error: [CommandApiBadRequest, CommandConflict, CommandApiUnexpectedError, ...extraErrors] as never
      })
    );

export const makeCommandApi = (basePath: `/${string}`, extraErrors: ReadonlyArray<Schema.Top> = []) =>
  HttpApi.make("commandApi").add(makeCommandApiGroup(basePath, extraErrors));
