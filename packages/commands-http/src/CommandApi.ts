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
export const makeCommandApi = (basePath: `/${string}`) =>
  HttpApi.make("commandApi").add(
    HttpApiGroup.make("commands")
      .add(HttpApiEndpoint.get("listExposedCommands", basePath).addSuccess(ExposedCommandsResponse))
      .add(
        HttpApiEndpoint.post("executeCommand", basePath)
          .setPayload(CommandEnvelope)
          .addError(CommandApiBadRequest)
          .addError(CommandConflict)
          .addError(CommandApiUnexpectedError)
      )
  );
