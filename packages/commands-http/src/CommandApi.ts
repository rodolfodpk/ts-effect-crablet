import * as Schema from "effect/Schema";
import { HttpApi, HttpApiEndpoint, HttpApiGroup, HttpApiSchema, OpenApi } from "effect/http-api";
import { inputJsonSchema } from "./InputJsonSchema.ts";
import { defaultWaitTimeoutMs, maxWaitTimeoutMs } from "./ViewWaiter.ts";
import type { SqlError } from "effect/sql/SqlError";
import type { Command } from "@crablet/commands/Command";
import type { AnyCommandContract } from "@crablet/commands/Contract";
import type { InvalidInput, KindedError } from "@crablet/commands/Errors";
import type { Conflict, Duplicate } from "@crablet/eventstore/AppendErrors";
import { CommandApiBadRequest, CommandConflict, CommandApiUnexpectedError, problemSchemaOf, type DeclaredDomainError, type ProblemBody } from "./ProblemDetail.ts";

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
// it has none. `lastTransactionId` is the transaction that wrote it (also a string): with the position it is the write's
// cursor, which a client compares with a view's progress to know the view has caught up. Created is 201, an idempotent repeat 200.
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
  lastTransactionId: Schema.String,
  view: Schema.optionalKey(ViewWaitResult)
}).annotate({ httpApiStatus: 201, identifier: "CommandCreated" } as never);

export const CommandIdempotentResponse = Schema.Struct({
  status: Schema.Literal("IDEMPOTENT"),
  reason: Schema.NullOr(Schema.String),
  lastPosition: Schema.Null,
  lastTransactionId: Schema.Null,
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
export const BadRequestProblem = asProblem(CommandApiBadRequest);
const ConflictProblem = asProblem(CommandConflict);
const UnexpectedProblem = asProblem(CommandApiUnexpectedError);

export const executeEndpointName = (commandType: string) => `execute_${commandType}`;

// Every error a command can fail with must be something the API knows how to present: a declared domain error (its KIND picks the HTTP
// status; `defineCommand` already requires it to be declared), or one of the framework's own errors (input validation, a stale decision, a
// repeated operation, a database failure). Anything else - a plain string, say, or an untagged class - is a compile error where the server
// registers its commands (`Implementations` below): it could only ever surface as a generic 500.
export type Presentable = KindedError | Conflict | Duplicate | SqlError | InvalidInput;

// ---- the group's STATIC type (the loop in `makeCommandApiGroup` builds exactly this) ----
//
// Each contract becomes one endpoint, `execute_<name>`, whose payload is the contract's input Schema and whose failures are the framework's
// three problems plus one problem per domain error the contract declared. A client derived from the API (`HttpApiClient.make`) is therefore
// typed per command: a misspelled payload field or an unknown command name does not compile, and the error channel names what that command
// can answer with. This needs the contracts' NAMES to be literal, so pass the list as written (`[A, B]`), not annotated as
// `ReadonlyArray<CommandContract>` (that forgets the names; the group is then typed by a `string` name, which is correct but no longer
// per command).

type ProblemsOf<Es> = Es extends ReadonlyArray<infer E> ? ProblemBody<E> : never;
type CommandErrorSchemas<Es> = typeof BadRequestProblem | typeof ConflictProblem | typeof UnexpectedProblem | ProblemsOf<Es>;
type CommandEndpoint<BasePath extends string, K extends AnyCommandContract> = HttpApiEndpoint.HttpApiEndpoint<
  `execute_${K["name"]}`,
  "POST",
  `${BasePath}/${K["name"]}`,
  never,
  ReturnType<typeof waitQuery>,
  K["input"] extends infer I extends Schema.Top ? I : never,
  never,
  typeof CommandCreatedResponse | typeof CommandIdempotentResponse,
  CommandErrorSchemas<K["errors"]>
>;
export type CommandGroup<BasePath extends string, C extends ReadonlyArray<AnyCommandContract>> = HttpApiGroup.HttpApiGroup<
  "commands",
  | HttpApiEndpoint.HttpApiEndpoint<"listExposedCommands", "GET", BasePath, never, never, never, never, typeof ExposedCommandsResponse>
  | { [N in C[number]["name"]]: CommandEndpoint<BasePath, Extract<C[number], { readonly name: N }>> }[C[number]["name"]]
>;

// Exported separately from `makeCommandApi` (which builds a *complete*, standalone `HttpApi`) so a bigger app-owned `HttpApi` can `.add()`
// this group alongside its own groups (e.g. a read-only query API) and serve them all from one router.
//
// The API is declared from CONTRACTS (the public part of each command, see @crablet/commands/Contract): the route is `POST {basePath}/{name}`
// with the contract's own `name`, and the module that declares the API imports nothing of the commands' behavior (decide, models, events), so
// it can be bundled for a browser. The group is built in a loop; the loop body is untyped (`any`) because TypeScript cannot follow a
// runtime-variable set of endpoint names through `group.add(...)`. The RETURN type is the precise `CommandGroup` above - the one place that
// asserts "the loop builds exactly this" (the OpenAPI description and the integration tests check the runtime, test/contract-api.types.ts the type).
// `waitableViews`: names of the views a request may wait for (`?waitFor=`, `?waitTimeout=`); none by default. (The query is part of the static
// type either way; with no waitable view the server answers any `waitFor` with a 400.)
export const makeCommandApiGroup = <const BasePath extends `/${string}`, const C extends ReadonlyArray<AnyCommandContract>>(
  basePath: BasePath,
  contracts: C,
  options: { readonly waitableViews?: ReadonlyArray<string> } = {}
): CommandGroup<BasePath, C> => {
  const waitableViews = options.waitableViews ?? [];
  let group: any = HttpApiGroup.make("commands").add(
    HttpApiEndpoint.get("listExposedCommands", basePath, { success: ExposedCommandsResponse })
  );
  for (const contract of contracts) {
    group = group.add(
      HttpApiEndpoint.post(executeEndpointName(contract.name), `${basePath}/${contract.name}` as `/${string}`, {
        payload: contract.input as unknown as Schema.Top,
        ...(waitableViews.length > 0 ? { query: waitQuery(waitableViews) } : {}),
        success: [CommandCreatedResponse, CommandIdempotentResponse] as never,
        error: [BadRequestProblem, ConflictProblem, UnexpectedProblem, ...contract.errors.map((e: DeclaredDomainError) => problemSchemaOf(e))] as never
      })
    );
  }
  return group as CommandGroup<BasePath, C>;
};

// The server's side of a list of contracts: for each contract, the implemented command, built from THAT contract with
// `defineCommand({ ...Contract, ... })`. A missing command, an extra one, or one built from a different contract does not compile; a
// command that can fail with an error the API cannot present (`Presentable`) does not compile either. (A command whose input Schema is
// strictly WIDER than the contract's is structurally assignable and not caught here: `checkImplementations` catches it at startup.)
export type Implementations<C extends ReadonlyArray<AnyCommandContract>> = {
  readonly [N in C[number]["name"]]: Command<any, Presentable, Extract<C[number], { readonly name: N }>["input"], Extract<C[number], { readonly name: N }>["errors"]>;
};

export class ContractMismatch extends Error {
  override readonly name = "ContractMismatch";
  readonly problems: ReadonlyArray<string>;
  // (no constructor parameter property: Node's type-stripping does not support the shorthand, see ADR-0001)
  constructor(problems: ReadonlyArray<string>) {
    super(`The commands do not implement the contracts:\n  - ${problems.join("\n  - ")}`);
    this.problems = problems;
  }
}

// Run when the server registers its implementations (cheap, once): every contract has a command under its name, there are no extras, and each
// command was built from its contract - the very same `input` and `errors` objects - rather than hand-written to resemble it.
export const checkImplementations = (
  contracts: ReadonlyArray<AnyCommandContract>,
  implementations: Readonly<Record<string, Command<any, any, any, any>>>
): void => {
  const problems: Array<string> = [];
  const names = new Set(contracts.map((contract) => contract.name));
  for (const contract of contracts) {
    const implementation = implementations[contract.name];
    if (implementation === undefined) problems.push(`no command for the contract "${contract.name}"`);
    else {
      if (implementation.name !== contract.name) problems.push(`the command registered as "${contract.name}" is named "${implementation.name}"`);
      if (implementation.input !== contract.input) problems.push(`"${contract.name}": the command's input is not the contract's (build it with defineCommand({ ...Contract, ... }))`);
      if (implementation.errors !== contract.errors) problems.push(`"${contract.name}": the command's declared errors are not the contract's (build it with defineCommand({ ...Contract, ... }))`);
    }
  }
  for (const name of Object.keys(implementations)) if (!names.has(name)) problems.push(`"${name}" is implemented but has no contract`);
  if (problems.length > 0) throw new ContractMismatch(problems);
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

export const makeCommandApi = <const BasePath extends `/${string}`, const C extends ReadonlyArray<AnyCommandContract>>(
  basePath: BasePath,
  contracts: C,
  info: ApiInfo = defaultApiInfo,
  options: { readonly waitableViews?: ReadonlyArray<string> } = {}
) => withApiInfo(HttpApi.make("commandApi").add(makeCommandApiGroup(basePath, contracts, options)), info);

export const listedCommands = (contracts: ReadonlyArray<Pick<AnyCommandContract, "name" | "input">>) =>
  [...contracts]
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .map((contract) => ({ commandType: contract.name, inputSchema: inputJsonSchema(contract) }));
