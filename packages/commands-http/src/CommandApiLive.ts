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
import { makeCommandApi, CommandEnvelope } from "./CommandApi.ts";
import type { ExposedCommand } from "./ExposedCommand.ts";
import type { CommandApiConfig } from "./CommandApiConfig.ts";
import { defaultBasePath } from "./CommandApiConfig.ts";
import { CommandApiBadRequest, CommandConflict, CommandApiUnexpectedError } from "./ProblemDetail.ts";

type CommandEnvelopePayload = Schema.Schema.Type<typeof CommandEnvelope>;

// What running a command needs from the environment: the executor plus what `execute` itself uses.
export type CommandApiRequirements = CommandExecutor | EventStore | CommandAuditStore | SqlClient.SqlClient;

// Duck-typed on the RFC 7807 shape (type/title/status/detail) rather than `instanceof` against a
// fixed list of known classes - this is what lets ExposedCommand.ts's per-command `mapError` hook
// surface an app-owned domain-error class (e.g. examples/wallet-example-app's own
// WalletNotFoundProblem) without commands-http needing to know that class exists. Anything that
// doesn't already look like a ProblemDetail (a framework-internal decode/encode error, an
// unrecognized handler-thrown value, ...) becomes a generic 500 with the real message not echoed.
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

// `commands` is the app-supplied flat map (commandType -> schema + handler); each entry keeps its own
// concrete T/E, so the map itself is type-erased at this boundary (see ExposedCommand.ts).
//
// Takes the full composed `api` as a parameter (generic over whatever bigger `HttpApi` the caller
// built, as long as it contains a `"commands"` group shaped like `makeCommandApiGroup` produces)
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

  const listExposedCommands = Effect.sync(() => ({
    exposedCommands: Object.keys(commands)
      .sort()
      .map((commandType) => ({ commandType }))
  }));

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

  // `HttpApiBuilder.group as any`: its signature requires "commands" to be statically known as a
  // member of `Groups`, which an arbitrary caller-supplied generic `Groups` can't prove to the
  // compiler (that is the point of accepting *any* bigger api that contains this group at runtime),
  // so the whole call is cast. Narrow, deliberate type-erasure at this one dynamic-composition
  // boundary - `payload`'s shape is recovered below via `CommandEnvelopePayload`.
  const groupBuilder = HttpApiBuilder.group as any;
  const CommandsLive: Layer.Layer<HttpApiGroup.Service<ApiId, "commands">, never, CommandApiRequirements> = groupBuilder(api, "commands", (handlers: any) =>
    Effect.succeed(
      handlers
        .handle("listExposedCommands", () => listExposedCommands)
        .handle("executeCommand", ({ payload }: { payload: CommandEnvelopePayload }) =>
          Effect.gen(function* () {
            const entry = commands[payload.commandType];
            if (!entry) {
              return yield* Effect.fail(CommandApiBadRequest.of(`Unknown command type: ${payload.commandType}`));
            }

            const command = yield* Schema.decodeUnknownEffect(entry.schema as Schema.Decoder<unknown>)(payload.command).pipe(
              Effect.catchTag("SchemaError", () =>
                Effect.fail(CommandApiBadRequest.of(`Invalid payload for commandType: ${payload.commandType}`))
              )
            );

            const correlationId = yield* resolveCorrelationId;

            // Only the command-execution call itself runs inside CorrelationContext - request
            // parsing/validation above deliberately does not. A `Conflict` (stale decision) or a
            // `Duplicate` (command opted into failing on repeats) becomes a 409 `CommandConflict`
            // before the entry's own `mapError` hook - neither is ever this command's own domain error.
            // Everything else (the handler's own E) gets one chance via `entry.mapError` to become a real
            // ProblemDetail (e.g. "wallet not found" -> 404) before falling through, unchanged, to the
            // outer terminal `toProblemDetail` catch-all. `matchingEventsCount` is always 0: the SQL
            // append does not report a count; the field is kept for wire compatibility.
            const executor = yield* CommandExecutor;
            const runExecute = executor.execute(payload.commandType, command, entry.handler).pipe(
              Effect.catchTag("Conflict", (e) =>
                Effect.fail(CommandConflict.of(e.message, e.kind === "guard" ? "GUARD_VIOLATION" : "DCB_VIOLATION", 0))
              ),
              Effect.catchTag("Duplicate", (e) =>
                Effect.fail(CommandConflict.of(e.message, "IDEMPOTENCY_VIOLATION", 0))
              ),
              Effect.catch((error) =>
                error instanceof CommandConflict ? Effect.fail(error) : Effect.fail(entry.mapError?.(error) ?? error)
              )
            );

            const result = yield* (correlationId !== null
              ? CorrelationContext.withCorrelationId(correlationId)(runExecute)
              : runExecute);

            // Raw response: the status (200 idempotent / 201 created) and optional correlation header
            // are chosen here, after the command ran.
            return HttpServerResponse.jsonUnsafe(
              result.wasIdempotent
                ? { status: "IDEMPOTENT" as const, reason: result.reason }
                : { status: "CREATED" as const, reason: null },
              {
                status: result.wasIdempotent ? 200 : 201,
                ...(correlationId !== null ? { headers: { [CORRELATION_HEADER]: correlationId } } : {})
              }
            );
          }).pipe(
            Effect.catch((error) => Effect.fail(toProblemDetail(error))),
            Effect.catchDefect((defect) => Effect.fail(toProblemDetail(defect)))
          )
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
  const api = makeCommandApi(basePath);
  return HttpApiBuilder.layer(api).pipe(Layer.provide(makeCommandApiGroupLive(api, commands, config)));
};
