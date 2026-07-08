import * as Schema from "effect/Schema";
import { HttpApi, HttpApiEndpoint, HttpApiGroup } from "@effect/platform";
import { CommandApiBadRequest, CommandConflict, CommandApiUnexpectedError } from "./ProblemDetail.ts";

// Port of com.crablet.command.web.internal.CommandApiRestController's two routes - GET (list
// exposed commands) and POST (execute) on the same configurable base path. Confirmed against a
// real running @effect/platform server (see NOTES.md's Phase 7 write-up) that POST's payload must
// be one *static* envelope shape, not a per-command-type schema resolved dynamically -
// HttpApiEndpoint.setPayload only accepts a schema known at API-definition time. All the
// "which concrete command is this" polymorphism happens inside CommandApiLive.ts's handler body,
// after decoding this envelope - exactly mirroring how Java's controller manually calls
// objectMapper.treeToValue(node, commandClass) *after* resolving commandType, rather than asking
// the framework to do polymorphic deserialization declaratively.
export const CommandEnvelope = Schema.Struct({
  commandType: Schema.String,
  command: Schema.Unknown
});

export const ExposedCommandsResponse = Schema.Struct({
  exposedCommands: Schema.Array(Schema.Struct({ commandType: Schema.String }))
});

// No .addSuccess() declared for the POST endpoint: the handler returns a raw HttpServerResponse
// with a dynamic status (200 idempotent / 201 created) chosen after CommandExecutor.execute runs,
// bypassing addSuccess's single-fixed-status-per-schema encoding entirely - confirmed working by
// the same spike (declaring one addSuccess schema here would be purely for documentation, and
// untested in combination with a raw-response return, so it's deliberately omitted rather than
// guessed at).
//
// Both endpoints share the exact same path (GET/POST /api/commands, differentiated only by HTTP
// method) - `basePath` is a runtime-configurable string, not known at API-authoring time, so this
// uses HttpApiEndpoint.get/post's plain (name, path) call form rather than the tagged-template
// form (which is only for extracting path *parameters*, not needed here).
//
// `extraErrors`: lets a consuming app (e.g. examples/wallet-example-app) declare its own
// domain-specific error schemas (its own plain Schema.Class, RFC 7807-shaped like ProblemDetail.ts's
// 3 built-in ones) on this same endpoint, so ExposedCommand.ts's per-command `mapError` hook has
// somewhere real to surface them - HttpApiEndpoint needs every possible error schema declared
// up front to encode/status-code it correctly, not just constructed at runtime. Exported
// separately from `makeCommandApi` (which builds a *complete*, standalone `HttpApi`) specifically
// so a bigger app-owned `HttpApi` can `.add()` this group alongside its own groups (e.g. a
// read-only query API) under one shared `HttpApiBuilder.serve()` - `HttpApi.Api` is a single
// `Context.Tag`, so two independent top-level `HttpApi.make(...)` instances can't both be served
// from one layer.
export const makeCommandApiGroup = (basePath: `/${string}`, extraErrors: ReadonlyArray<Schema.Schema.All> = []) => {
  const baseEndpoint = HttpApiEndpoint.post("executeCommand", basePath)
    .setPayload(CommandEnvelope)
    .addError(CommandApiBadRequest)
    .addError(CommandConflict)
    .addError(CommandApiUnexpectedError);

  // `as any`/`as never`: each `.addError(...)` call narrows the endpoint's error-type parameter
  // further, so a `.reduce` over a runtime-variable-length array can't be tracked statically -
  // there's no dependent-typing way to express "the accumulated type after N calls, where N is a
  // runtime array length." Narrow, deliberate type-erasure at this one dynamic-composition
  // boundary, same pragmatism as `ExposedCommand<any, any>`'s own erased registry.
  const executeEndpoint = extraErrors.reduce(
    (endpoint, errorSchema) => endpoint.addError(errorSchema as never) as typeof baseEndpoint,
    baseEndpoint
  );

  return HttpApiGroup.make("commands")
    .add(HttpApiEndpoint.get("listExposedCommands", basePath).addSuccess(ExposedCommandsResponse))
    .add(executeEndpoint);
};

export const makeCommandApi = (basePath: `/${string}`, extraErrors: ReadonlyArray<Schema.Schema.All> = []) =>
  HttpApi.make("commandApi").add(makeCommandApiGroup(basePath, extraErrors));
