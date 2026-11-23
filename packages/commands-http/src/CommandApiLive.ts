import { Effect, Layer } from "effect";
import * as Schema from "effect/Schema";
import { HttpApiBuilder } from "effect/http-api";
import type { HttpApi, HttpApiGroup } from "effect/http-api";
import { HttpServerRequest, HttpServerResponse } from "effect/http";
import { CommandExecutor } from "@crablet/commands";
import * as CorrelationContext from "@crablet/eventstore/CorrelationContext";
import { formatMarker } from "@crablet/eventstore/Marker";
import { checkImplementations, executeEndpointName, listedCommands, makeCommandApi } from "./CommandApi.ts";
import type { Implementations } from "./CommandApi.ts";
import type { AnyCommandContract } from "@crablet/commands/Contract";
import type { Command } from "@crablet/commands/Command";
import { apiDocsLayer, apiLayerOptions } from "./ApiDescription.ts";
import type { CommandApiConfig } from "./CommandApiConfig.ts";
import { defaultBasePath } from "./CommandApiConfig.ts";
import { kindOf, type InputIssue } from "@crablet/commands/Errors";
import { CommandApiBadRequest, CommandConflict, CommandApiUnexpectedError, CommandIdempotencyMismatch, domainProblemOf } from "./ProblemDetail.ts";

// What running a command needs from the environment. The executor brings its own event store, audit store and SQL client (its layer resolves
// them), so it is all a command endpoint needs; `requirementsMatchTheHandler` below checks this against the handler's type.
export type CommandApiRequirements = CommandExecutor;

// The part of a group's handler registry this layer uses, as a structural type (see `groupBuilder` below). A raw handler answers with the response it builds, and
// needs the request (the router's) and what `CommandApiRequirements` names, nothing else.
interface CommandHandlerRegistry {
  readonly handle: (
    name: "listExposedCommands",
    handler: () => Effect.Effect<{ readonly exposedCommands: ReadonlyArray<{ readonly commandType: string; readonly inputSchema: unknown }> }>
  ) => CommandHandlerRegistry;
  readonly handleRaw: (
    name: string,
    handler: () => Effect.Effect<HttpServerResponse.HttpServerResponse, unknown, HttpServerRequest.HttpServerRequest | CommandApiRequirements>
  ) => CommandHandlerRegistry;
}
type CommandGroupBuilder<Out> = (
  api: unknown,
  id: "commands",
  build: (handlers: CommandHandlerRegistry) => Effect.Effect<CommandHandlerRegistry>
) => Layer.Layer<Out, never, CommandApiRequirements>;

// True when A and B are the same type (not merely assignable one way).
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

// Duck-typed on the RFC 7807 shape (type/title/status/detail) rather than `instanceof` against a
// fixed list of known classes: a domain error's problem is a plain object built from its declared
// kind and fields (see ProblemDetail.ts). Anything that doesn't already look like a problem (a
// framework-internal decode/encode error, an unrecognized handler-thrown value, ...) becomes a generic
// 500 with the real message not echoed.
const isProblemDetailShaped = (value: unknown): value is object =>
  typeof value === "object" &&
  value !== null &&
  "type" in value &&
  "title" in value &&
  "status" in value &&
  "detail" in value;

const toProblemDetail = (error: unknown): object => (isProblemDetailShaped(error) ? error : CommandApiUnexpectedError.instance);

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
): Layer.Layer<HttpApiGroup.Service<ApiId, "commands">, never, CommandApiRequirements> => {
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

  // The layer's requirements are declared below through the `as any` group builder, so the compiler cannot see them; this checks them against
  // what the handler really needs (the request is the router's), so `CommandApiRequirements` cannot drift from the code without a compile error.
  const requirementsMatchTheHandler: Equal<
    Exclude<Effect.Services<ReturnType<typeof handleCommand>>, HttpServerRequest.HttpServerRequest>,
    CommandApiRequirements
  > = true;
  void requirementsMatchTheHandler;

  // `HttpApiBuilder.group` types its registry by the endpoints of the API, which cannot be expressed here: "commands" is a member of a caller's generic
  // `Groups`, and the endpoint names are one per contract, known only at run time. So the builder is taken as the structural type above (`CommandGroupBuilder`), and
  // what is registered through it is checked against that type: the handler's own requirements, its response, its errors.
  // type escape: `HttpApiBuilder.group` as `CommandGroupBuilder`; the one place the registry's precise type is replaced by the structural one
  const groupBuilder = HttpApiBuilder.group as unknown as CommandGroupBuilder<HttpApiGroup.Service<ApiId, "commands">>;
  const CommandsLive = groupBuilder(api, "commands", (handlers) =>
    Effect.succeed(
      Object.entries(implementations as Readonly<Record<string, Command<any, any, any, any>>>).reduce(
        (h, [commandType, command]) => h.handleRaw(executeEndpointName(commandType), () => handleCommand(commandType, command)),
        handlers.handle("listExposedCommands", () => listExposedCommands)
      )
    )
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
