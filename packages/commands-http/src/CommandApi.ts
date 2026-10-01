import * as Schema from "effect/Schema";
import { HttpApi, HttpApiEndpoint, HttpApiGroup, HttpApiSchema, OpenApi } from "effect/http-api";
import { inputJsonSchema } from "./InputJsonSchema.ts";
import { defaultWaitTimeoutMs, maxWaitTimeoutMs } from "./ViewWaiter.ts";
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
//
// `view` is present only when the request asked to wait for a view (`?waitFor=`): whether that view had caught up
// to this write when the response was sent. The write itself has succeeded either way - a view that did not catch
// up in time (or is failed) is reported here, not as an error status, because the command is done and
// retrying it would be wrong. reason: `timeout` (not caught up in time), `view_failed` (the view is marked FAILED), `unavailable`
// (its progress could not be read), `nothing_appended`: an idempotent repeat appended nothing, so there was nothing to wait for.
export const ViewWaitResult = Schema.Struct({
  name: Schema.String,
  caughtUp: Schema.Boolean,
  reason: Schema.optionalKey(Schema.Literals(["timeout", "view_failed", "unavailable", "nothing_appended"]))
}).annotate({ identifier: "ViewWaitResult" } as never);

export const CommandCreatedResponse = Schema.Struct({
  status: Schema.Literal("CREATED"),
  reason: Schema.Null,
  lastPosition: Schema.String,
  view: Schema.optionalKey(ViewWaitResult)
}).annotate({ httpApiStatus: 201, identifier: "CommandCreated" } as never);

export const CommandIdempotentResponse = Schema.Struct({
  status: Schema.Literal("IDEMPOTENT"),
  reason: Schema.NullOr(Schema.String),
  lastPosition: Schema.Null,
  view: Schema.optionalKey(ViewWaitResult)
}).annotate({ httpApiStatus: 200, identifier: "CommandIdempotent" } as never);

// The optional query parameters of a command route when views can be waited for. Plain strings on purpose: the
// handler validates them itself (BEFORE running the command), so a bad value answers with the same problem
// body as every other 400 instead of the HTTP framework's empty-bodied default; the allowed values are
// documented in the descriptions.
export const waitQuery = (viewNames: ReadonlyArray<string>) =>
  Schema.Struct({
    waitFor: Schema.optionalKey(
      Schema.String.annotate({
        description: `Wait for this view to process the write before responding, so a following read is not stale. One of: ${viewNames.join(", ")}.`
      } as never)
    ),
    waitTimeout: Schema.optionalKey(
      Schema.String.annotate({
        description: `How long to wait, in milliseconds (whole number, 1 to ${maxWaitTimeoutMs}; default ${defaultWaitTimeoutMs}). Needs waitFor.`
      } as never)
    )
  });

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
// `waitableViews`: names of the views a request may wait for (`?waitFor=`, `?waitTimeout=`); none by default.
export const makeCommandApiGroup = (
  basePath: `/${string}`,
  commands: Registry,
  options: { readonly waitableViews?: ReadonlyArray<string> } = {}
): HttpApiGroup.HttpApiGroup<"commands", any> => {
  const waitableViews = options.waitableViews ?? [];
  let group: any = HttpApiGroup.make("commands").add(
    HttpApiEndpoint.get("listExposedCommands", basePath, { success: ExposedCommandsResponse })
  );
  for (const [commandType, entry] of Object.entries(commands)) {
    group = group.add(
      HttpApiEndpoint.post(executeEndpointName(commandType), `${basePath}/${commandType}` as `/${string}`, {
        payload: entry.command.input as unknown as Schema.Top,
        ...(waitableViews.length > 0 ? { query: waitQuery(waitableViews) } : {}),
        success: [CommandCreatedResponse, CommandIdempotentResponse] as never,
        error: [BadRequestProblem, ConflictProblem, UnexpectedProblem, ...entry.command.errors.map((e) => problemSchemaOf(e))] as never
      })
    );
  }
  return group;
};

// What the API description says about the API as a whole.
export interface ApiInfo {
  readonly title: string;
  readonly version: string;
  readonly description?: string;
}

export const defaultApiInfo: ApiInfo = { title: "Command API", version: "1.0.0" };

// Attaches the title / version / description the generated OpenAPI document shows.
export const withApiInfo = <Id extends string, Groups extends HttpApiGroup.Constraint>(
  api: HttpApi.HttpApi<Id, Groups>,
  info: ApiInfo
): HttpApi.HttpApi<Id, Groups> =>
  api.annotateMerge(
    OpenApi.annotations({ title: info.title, version: info.version, ...(info.description !== undefined ? { description: info.description } : {}) })
  );

export const makeCommandApi = (
  basePath: `/${string}`,
  commands: Registry,
  info: ApiInfo = defaultApiInfo,
  options: { readonly waitableViews?: ReadonlyArray<string> } = {}
) => withApiInfo(HttpApi.make("commandApi").add(makeCommandApiGroup(basePath, commands, options)), info);

export const listedCommands = (commands: Registry) =>
  Object.keys(commands)
    .sort()
    .map((commandType) => ({ commandType, inputSchema: inputJsonSchema(commands[commandType]!.command) }));
