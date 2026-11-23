import { Effect, Layer } from "effect";
import * as Schema from "effect/Schema";
import { HttpApi, HttpApiBuilder } from "effect/http-api";
import type { HttpApiGroup } from "effect/http-api";
import { HttpServerRequest, HttpServerResponse } from "effect/http";
import { CommandExecutor } from "@crablet/commands";
import * as CorrelationContext from "@crablet/eventstore/CorrelationContext";
import { formatMarker } from "@crablet/eventstore/Marker";
import { checkImplementations, executeEndpointName, listedCommands, makeCommandApi, makeCommandApiGroup } from "./CommandApi.ts";
import type { Implementations } from "./CommandApi.ts";
import type { AnyCommandContract } from "@crablet/commands/Contract";
import type { Command } from "@crablet/commands/Command";
import { apiDocsLayer, apiLayerOptions } from "./ApiDescription.ts";
import type { CommandApiConfig } from "./CommandApiConfig.ts";
import { defaultBasePath } from "./CommandApiConfig.ts";
import { kindOf, type InputIssue } from "@crablet/commands/Errors";
import { CommandApiBadRequest, CommandConflict, CommandApiUnexpectedError, CommandIdempotencyMismatch, domainProblemOf, isDomainProblemBody, type DomainProblemBody } from "./ProblemDetail.ts";

// What the command group's layer needs, as the compiler derives it from `makeCommandApiGroupLive` below (not written by hand): the executor, which brings its
// own event store, audit store and SQL client.
type RequirementsOf<L> = L extends Layer.Layer<infer _A, infer _E, infer R> ? R : never;
export type CommandApiRequirements = RequirementsOf<ReturnType<typeof makeCommandApiGroupLive>>;

// A command endpoint's failures are its declared problems; anything else (a framework-internal decode or encode error, an unrecognized value a handler
// threw) becomes a generic 500, with the real message not echoed.
// What a command endpoint fails with, as its description declares it: the framework's four problems, or a declared domain error's problem body.
type CommandProblem = CommandApiBadRequest | CommandConflict | CommandIdempotencyMismatch | CommandApiUnexpectedError | DomainProblemBody;
const toProblemDetail = (error: unknown): CommandProblem =>
  error instanceof CommandApiBadRequest || error instanceof CommandConflict || error instanceof CommandIdempotencyMismatch || error instanceof CommandApiUnexpectedError || isDomainProblemBody(error)
    ? error
    : CommandApiUnexpectedError.instance;

const CORRELATION_HEADER = "x-correlation-id";

const uuid = Schema.String.check(Schema.isUUID());

// The group's implementation, from the API's contracts and the command implemented for each (`implementations`, keyed by the contract's name,
// each built with `defineCommand({ ...Contract, ... })`). The pairing is checked by the types (`Implementations`) and again here, once, when the layer
// is built (`checkImplementations`: a missing, extra or look-alike command throws a `ContractMismatch` naming every problem).
//
// Takes the full composed `api` as a parameter (generic over whatever bigger `HttpApi` the caller built, as long as it contains a `"commands"` group made
// by `makeCommandApiGroup` from the SAME contracts) rather than building it internally, so a consuming app can compose this group alongside its own
// groups under one router. Returns just the group's implementation Layer, like `HttpApiBuilder.group` itself - wrapping it in `HttpApiBuilder.layer(...)`
// is the caller's job (see `makeCommandApiLive` below for the standalone case).
export const makeCommandApiGroupLive = <ApiId extends string, Groups extends HttpApiGroup.Constraint, const C extends ReadonlyArray<AnyCommandContract>>(
  api: HttpApi.HttpApi<ApiId, Groups>,
  contracts: C,
  implementations: Implementations<C>,
  config: CommandApiConfig = {}
) => {
  checkImplementations(contracts, implementations);
  const correlationHeaderEnabled = config.correlationHeaderEnabled ?? false;

  const listExposedCommands = Effect.sync(() => ({ exposedCommands: listedCommands(contracts) }));

  // Resolves the optional correlation id: disabled -> ignore any inbound header entirely; enabled +
  // present -> validate as a UUID (fail 400 if malformed) and echo it back; enabled + absent ->
  // generate one and echo it. Returns null when disabled, so the caller knows not to wrap the
  // execution in CorrelationContext at all.
  const resolveCorrelationId: Effect.Effect<
    string | null,
    CommandApiBadRequest,
    HttpServerRequest.HttpServerRequest
  > = Effect.gen(function* () {
    if (!correlationHeaderEnabled) return null;
    const request = yield* HttpServerRequest.HttpServerRequest;
    const raw = request.headers[CORRELATION_HEADER];
    if (raw === undefined) return crypto.randomUUID();
    const decoded = Schema.decodeUnknownExit(uuid)(raw);
    if (decoded._tag === "Failure") {
      return yield* Effect.fail(CommandApiBadRequest.of("Invalid X-Correlation-Id header"));
    }
    return raw;
  });

  // One handler per exposed command. The body is decoded here, with the command's own `decodeInput`, rather
  // than by the HTTP framework (`handleRaw`), so a malformed or invalid body answers with a problem body.
  const handleCommand = (commandType: string, command: Command<any, any, any, any>) =>
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const invalidPayload = (issues?: ReadonlyArray<InputIssue>) => CommandApiBadRequest.of(`Invalid payload for command: ${commandType}`, issues);
      const raw = yield* request.json.pipe(Effect.mapError(() => invalidPayload()));
      // Validation belongs to the command itself: its input schema. Every failed field is reported, by path.
      const input = yield* command.decodeInput(raw).pipe(Effect.mapError((error) => invalidPayload(error.issues)));

      const correlationId = yield* resolveCorrelationId;

      // Only the command-execution call itself runs inside CorrelationContext - request parsing and
      // validation above deliberately do not. A `Conflict` (a stale decision, after the retries) becomes a
      // 409 `CommandConflict` - it is never this command's own domain error. A declared domain error is presented by its KIND with its own fields (see
      // ProblemDetail.ts). Anything still unrecognized falls through, unchanged, to the terminal
      // `toProblemDetail` catch-all below (a generic 500).
      const executor = yield* CommandExecutor;
      const runExecute = executor.runDecoded(command, input).pipe(
        Effect.catchTag("Conflict", (e) =>
          Effect.fail(CommandConflict.of(e.message, e.kind === "guard" ? "GUARD_VIOLATION" : "DCB_VIOLATION"))
        ),
        // A request id reused with a different body: 422, never "already done" (ADR-0034).
        Effect.catchTag("IdempotencyMismatch", (e) => Effect.fail(CommandIdempotencyMismatch.of(e.message))),
        Effect.catch((error) => {
          if (error instanceof CommandConflict || error instanceof CommandIdempotencyMismatch) return Effect.fail(error);
          const kind = kindOf(error);
          return Effect.fail(kind !== undefined ? domainProblemOf(kind, error) : error);
        })
      );

      const result = yield* correlationId !== null
        ? CorrelationContext.withCorrelationId(correlationId)(runExecute)
        : runExecute;

      // Raw response: the status (201 created / 200 idempotent) and optional correlation header are
      // chosen here, after the command ran.
      return HttpServerResponse.jsonUnsafe(
        // The response spells the marker out (position and transaction id as strings) beside its one-string form. Null for an idempotent
        // result with nothing to point at (ADR-0034); a created one always has a marker.
        {
          status: result.wasIdempotent ? ("IDEMPOTENT" as const) : ("CREATED" as const),
          reason: result.wasIdempotent ? result.reason : null,
          lastPosition: result.marker === null ? null : String(result.marker.position),
          lastTransactionId: result.marker?.transactionId ?? null,
          marker: result.marker === null ? null : formatMarker(result.marker)
        },
        {
          status: result.wasIdempotent ? 200 : 201,
          ...(correlationId !== null ? { headers: { [CORRELATION_HEADER]: correlationId } } : {})
        }
      );
    }).pipe(
      Effect.catch((error) => Effect.fail(toProblemDetail(error))),
      Effect.catchDefect((defect) => Effect.fail(toProblemDetail(defect)))
    );

  // The group is registered against an API of its own: the caller's identifier, and only this group, built from the same contracts and base path. Its type is
  // concrete (the contracts read as `ReadonlyArray<AnyCommandContract>`, so every command endpoint is `execute_${string}`), so `HttpApiBuilder.group` types the
  // handlers and derives the layer's error and requirements itself: nothing here asserts a layer's type. The served group is the caller's, made by
  // `makeCommandApiGroup` from the same contracts; the service the layer provides is keyed by the API's identifier and the group's, so it is the one the caller's
  // API needs.
  const everyContract: ReadonlyArray<AnyCommandContract> = contracts;
  const commandsApi = HttpApi.make(api.identifier).add(makeCommandApiGroup((config.basePath ?? defaultBasePath) as `/${string}`, everyContract));
  const commandEntries = Object.entries(implementations as Readonly<Record<string, Command<any, any, any, any>>>);

  const CommandsLive = HttpApiBuilder.group(commandsApi, "commands", (handlers) =>
    // The executor is taken when the group is built and given to each request (ADR-0042): a requirement of this layer, met once, not of every request.
    Effect.map(Effect.context<CommandExecutor>(), (services) => {
      const listed = handlers.handle("listExposedCommands", () => listExposedCommands);
      // One command endpoint, registered with the handler every command gets: this step is typed, and gives the registry its requirements and errors.
      const registerCommand = (registry: typeof listed, commandType: string, command: Command<any, any, any, any>) =>
        registry.handleRaw(executeEndpointName(commandType), () => handleCommand(commandType, command).pipe(Effect.provideContext(services)));
      type Registered = ReturnType<typeof registerCommand>;
      // type escape: at the type level every command endpoint is the one identifier `execute_${string}`, handled after the first registration; at run time there is one
      // per contract, so the fold hands each step the registry as it was before that identifier was handled. The requirements and errors are those of `registerCommand`.
      const registered = commandEntries.reduce<typeof listed | Registered>((registry, [commandType, command]) => registerCommand(registry as typeof listed, commandType, command), listed);
      // type escape: see above (with no contracts there is no command endpoint to handle, and the registry is `listed`)
      return registered as Registered;
    })
  );

  return CommandsLive;
};

// Standalone convenience wrapper: builds its own complete `HttpApi` and returns the ready-to-serve
// route Layer (serve it with `HttpRouter.serve(...)`), for callers that don't compose anything else
// alongside it.
export const makeCommandApiLive = <const C extends ReadonlyArray<AnyCommandContract>>(
  contracts: C,
  implementations: Implementations<C>,
  config: CommandApiConfig = {}
) => {
  const basePath = (config.basePath ?? defaultBasePath) as `/${string}`;
  const api = makeCommandApi(basePath, contracts);
  return Layer.merge(
    HttpApiBuilder.layer(api, apiLayerOptions(config)).pipe(Layer.provide(makeCommandApiGroupLive(api, contracts, implementations, config))),
    apiDocsLayer(api, config)
  );
};
