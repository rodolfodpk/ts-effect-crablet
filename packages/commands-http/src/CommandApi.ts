import * as Schema from "effect/Schema";
import { HttpApi, HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "effect/http-api";
import { inputJsonSchema } from "./InputJsonSchema.ts";
import type { ExposedCommand } from "./ExposedCommand.ts";
import { CommandApiBadRequest, CommandConflict, CommandApiUnexpectedError, problemSchemaOf } from "./ProblemDetail.ts";

// The command API's description: ONE route per exposed command, `POST {basePath}/{name}`, whose request
// body is the command's own input schema, plus `GET {basePath}` listing the exposed commands with their
// input schemas. Each route documents exactly the failures that command can have: the framework's own
// (bad payload 400, stale decision 409, unexpected 500) and the domain errors the command declared (status
// from the error's kind, body typed with the error's own fields). Problems are `application/problem+json`.
//
// The routes are built when the group is built - the registry is known then - so this is a function of the
// registry, not a static value. The handlers (CommandApiLive.ts) decode the body themselves with the
// command's `decodeInput`, so a bad payload answers with the same problem body as any other 400 instead of
// the HTTP framework's empty-bodied default; the payload schema declared here is what the description shows.

// What running a command reports. `lastPosition` is the log position of the last event it appended (as a
// string: the position is a bigint and JSON cannot carry one); an idempotent repeat appended nothing, so
// it has none. Created is 201, an idempotent repeat 200.
export const CommandCreatedResponse = Schema.Struct({
  status: Schema.Literal("CREATED"),
  reason: Schema.Null,
  lastPosition: Schema.String
}).annotate({ httpApiStatus: 201, identifier: "CommandCreated" } as never);

export const CommandIdempotentResponse = Schema.Struct({
  status: Schema.Literal("IDEMPOTENT"),
  reason: Schema.NullOr(Schema.String),
  lastPosition: Schema.Null
}).annotate({ httpApiStatus: 200, identifier: "CommandIdempotent" } as never);

export const ExposedCommandsResponse = Schema.Struct({
  exposedCommands: Schema.Array(
    Schema.Struct({
      commandType: Schema.String,
      // the command's input as JSON Schema (draft 2020-12)
      inputSchema: Schema.Unknown
    })
  )
});

const asProblem = <S extends Schema.Top>(schema: S) => schema.pipe(HttpApiSchema.asJson({ contentType: "application/problem+json" }));
const BadRequestProblem = asProblem(CommandApiBadRequest);
const ConflictProblem = asProblem(CommandConflict);
const UnexpectedProblem = asProblem(CommandApiUnexpectedError);

export const executeEndpointName = (commandType: string) => `execute_${commandType}`;

type Registry = Readonly<Record<string, ExposedCommand<any, any>>>;

// Exported separately from `makeCommandApi` (which builds a *complete*, standalone `HttpApi`) so a
// bigger app-owned `HttpApi` can `.add()` this group alongside its own groups (e.g. a read-only
// query API) and serve them all from one router.
//
// The group is built in a loop from the registry, so its static type is erased (`any`): TypeScript cannot
// track a runtime-variable set of endpoint names. That is the one deliberate type-erasure here.
export const makeCommandApiGroup = (basePath: `/${string}`, commands: Registry): HttpApiGroup.HttpApiGroup<"commands", any> => {
  let group: any = HttpApiGroup.make("commands").add(
    HttpApiEndpoint.get("listExposedCommands", basePath, { success: ExposedCommandsResponse })
  );
  for (const [commandType, entry] of Object.entries(commands)) {
    group = group.add(
      HttpApiEndpoint.post(executeEndpointName(commandType), `${basePath}/${commandType}` as `/${string}`, {
        payload: entry.command.input as unknown as Schema.Top,
        success: [CommandCreatedResponse, CommandIdempotentResponse] as never,
        error: [BadRequestProblem, ConflictProblem, UnexpectedProblem, ...entry.errors.map((e) => problemSchemaOf(e))] as never
      })
    );
  }
  return group;
};

export const makeCommandApi = (basePath: `/${string}`, commands: Registry) =>
  HttpApi.make("commandApi").add(makeCommandApiGroup(basePath, commands));

export const listedCommands = (commands: Registry) =>
  Object.keys(commands)
    .sort()
    .map((commandType) => ({ commandType, inputSchema: inputJsonSchema(commands[commandType]!.command) }));
