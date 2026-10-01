import { Effect, Layer } from "effect";
import * as Schema from "effect/Schema";
import { HttpApiBuilder } from "effect/http-api";
import type { HttpApi, HttpApiGroup } from "effect/http-api";
import { HttpServerRequest, HttpServerResponse } from "effect/http";
import { CommandExecutor } from "@crablet/commands";
import type { SqlClient } from "effect/sql";
import type { EventStore } from "@crablet/eventstore";
import type { CommandAuditStore } from "@crablet/eventstore/CommandAuditStore";
import * as CorrelationContext from "@crablet/eventstore/CorrelationContext";
import { executeEndpointName, listedCommands, makeCommandApi } from "./CommandApi.ts";
import { apiDocsLayer, apiLayerOptions } from "./ApiDescription.ts";
import type { ExposedCommand } from "./ExposedCommand.ts";
import type { CommandApiConfig } from "./CommandApiConfig.ts";
import { defaultBasePath } from "./CommandApiConfig.ts";
import { kindOf } from "@crablet/commands/Errors";
import { CommandApiBadRequest, CommandConflict, CommandApiUnexpectedError, domainProblemOf } from "./ProblemDetail.ts";

// What running a command needs from the environment: the executor plus what `execute` itself uses.
export type CommandApiRequirements = CommandExecutor | EventStore | CommandAuditStore | SqlClient.SqlClient;

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

// `commands` is the app-supplied flat map (name -> command + declared errors); each entry keeps its own
// concrete T/E, so the map itself is type-erased at this boundary (see ExposedCommand.ts).
//
// Takes the full composed `api` as a parameter (generic over whatever bigger `HttpApi` the caller
// built, as long as it contains a `"commands"` group made by `makeCommandApiGroup` from the SAME registry)
// rather than building it internally, so a consuming app can compose this group alongside its own
// groups under one router. Returns just the group's implementation Layer, like
// `HttpApiBuilder.group` itself - wrapping it in `HttpApiBuilder.layer(...)` is the caller's job
// (see `makeCommandApiLive` below for the standalone case).
export const makeCommandApiGroupLive = <ApiId extends string, Groups extends HttpApiGroup.Constraint>(
  api: HttpApi.HttpApi<ApiId, Groups>,
  commands: Readonly<Record<string, ExposedCommand<any, any>>>,
  config: CommandApiConfig = {}
): Layer.Layer<HttpApiGroup.Service<ApiId, "commands">, never, CommandApiRequirements> => {
  const correlationHeaderEnabled = config.correlationHeaderEnabled ?? false;

  const listExposedCommands = Effect.sync(() => ({ exposedCommands: listedCommands(commands) }));

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
  const handleCommand = (commandType: string, entry: ExposedCommand<any, any>) =>
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const invalidPayload = () => CommandApiBadRequest.of(`Invalid payload for command: ${commandType}`);
      const raw = yield* request.json.pipe(Effect.mapError(invalidPayload));
      // Validation belongs to the command itself: its input schema.
      const input = yield* entry.command.decodeInput(raw).pipe(Effect.mapError(invalidPayload));

      const correlationId = yield* resolveCorrelationId;

      // Only the command-execution call itself runs inside CorrelationContext - request parsing and
      // validation above deliberately do not. A `Conflict` (stale decision) or a `Duplicate` (command
      // opted into failing on repeats) becomes a 409 `CommandConflict` - neither is ever this command's own
      // domain error. A declared domain error is presented by its KIND with its own fields (see
      // ProblemDetail.ts). Anything still unrecognized falls through, unchanged, to the terminal
      // `toProblemDetail` catch-all below (a generic 500).
      const executor = yield* CommandExecutor;
      const runExecute = executor.runDecoded(entry.command, input).pipe(
        Effect.catchTag("Conflict", (e) =>
          Effect.fail(CommandConflict.of(e.message, e.kind === "guard" ? "GUARD_VIOLATION" : "DCB_VIOLATION"))
        ),
        Effect.catchTag("Duplicate", (e) => Effect.fail(CommandConflict.of(e.message, "IDEMPOTENCY_VIOLATION"))),
        Effect.catch((error) => {
          if (error instanceof CommandConflict) return Effect.fail(error);
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
        result.wasIdempotent
          ? { status: "IDEMPOTENT" as const, reason: result.reason, lastPosition: null }
          : { status: "CREATED" as const, reason: null, lastPosition: String(result.lastPosition) },
        {
          status: result.wasIdempotent ? 200 : 201,
          ...(correlationId !== null ? { headers: { [CORRELATION_HEADER]: correlationId } } : {})
        }
      );
    }).pipe(
      Effect.catch((error) => Effect.fail(toProblemDetail(error))),
      Effect.catchDefect((defect) => Effect.fail(toProblemDetail(defect)))
    );

  // `HttpApiBuilder.group as any`: its signature requires "commands" to be statically known as a
  // member of `Groups`, and the endpoint names are only known at run time (one per registry entry), so
  // the whole call is cast. Narrow, deliberate type-erasure at this one dynamic-composition boundary.
  const groupBuilder = HttpApiBuilder.group as any;
  const CommandsLive: Layer.Layer<HttpApiGroup.Service<ApiId, "commands">, never, CommandApiRequirements> = groupBuilder(api, "commands", (handlers: any) =>
    Effect.succeed(
      Object.entries(commands).reduce(
        (h: any, [commandType, entry]) => h.handleRaw(executeEndpointName(commandType), () => handleCommand(commandType, entry)),
        handlers.handle("listExposedCommands", () => listExposedCommands)
      )
    )
  );

  return CommandsLive;
};

// Standalone convenience wrapper: builds its own complete `HttpApi` and returns the ready-to-serve
// route Layer (serve it with `HttpRouter.serve(...)`), for callers that don't compose anything else
// alongside it.
export const makeCommandApiLive = (
  commands: Readonly<Record<string, ExposedCommand<any, any>>>,
  config: CommandApiConfig = {}
) => {
  const basePath = (config.basePath ?? defaultBasePath) as `/${string}`;
  const api = makeCommandApi(basePath, commands);
  return Layer.merge(
    HttpApiBuilder.layer(api, apiLayerOptions(config)).pipe(Layer.provide(makeCommandApiGroupLive(api, commands, config))),
    apiDocsLayer(api, config)
  );
};
