import { Effect, Layer } from "effect";
import * as Schema from "effect/Schema";
import { HttpApiBuilder, HttpServerRequest, HttpServerResponse } from "@effect/platform";
import { CommandExecutor } from "@crablet/commands";
import * as CorrelationContext from "@crablet/eventstore/CorrelationContext";
import type { ConcurrencyException } from "@crablet/eventstore/DCBViolation";
import { makeCommandApi } from "./CommandApi.ts";
import type { ExposedCommand } from "./ExposedCommand.ts";
import type { CommandApiConfig } from "./CommandApiConfig.ts";
import { defaultBasePath } from "./CommandApiConfig.ts";
import { CommandApiBadRequest, CommandConflict, CommandApiUnexpectedError } from "./ProblemDetail.ts";

// Any error reaching the handler's outer boundary that isn't already one of our three
// ProblemDetail types (a framework-internal decode/encode error, an unmapped handler-thrown
// value, ...) becomes a generic 500 - the same terminal "catch-all Exception -> 500, message not
// echoed" safety net Java's CommandApiExceptionHandler applies, rather than trying to enumerate
// every possible framework-internal error type by hand.
const toProblemDetail = (
  error: unknown
): CommandApiBadRequest | CommandConflict | CommandApiUnexpectedError =>
  error instanceof CommandApiBadRequest || error instanceof CommandConflict || error instanceof CommandApiUnexpectedError
    ? error
    : CommandApiUnexpectedError.instance;

const CORRELATION_HEADER = "x-correlation-id";

// Port of com.crablet.command.web.internal.CommandApiRestController.executeCommand +
// CommandApiExceptionHandler. `commands` is the app-supplied flat map replacing Java's two-tier
// reflection registry (see ExposedCommand.ts's primer) - each entry keeps its own concrete T/E, so
// the map itself is type-erased at this boundary the same way AutomationEventHandler.ts's
// registry is.
export const makeCommandApiLive = (
  // `Record<string, ExposedCommand<any, any>>` - see ExposedCommand.ts's primer on why this
  // registry is type-erased at this boundary, never in the public per-entry API.
  commands: Readonly<Record<string, ExposedCommand<any, any>>>,
  config: CommandApiConfig = {}
) => {
  const basePath = (config.basePath ?? defaultBasePath) as `/${string}`;
  const correlationHeaderEnabled = config.correlationHeaderEnabled ?? false;
  const api = makeCommandApi(basePath);

  const listExposedCommands = Effect.sync(() => ({
    exposedCommands: Object.keys(commands)
      .sort()
      .map((commandType) => ({ commandType }))
  }));

  // Resolves the optional correlation id per the port's precise spec: disabled -> ignore any
  // inbound header entirely; enabled + present -> validate as a UUID (fail 400 if malformed) and
  // echo it back; enabled + absent -> generate one and echo it. Returns null when disabled, so the
  // caller knows not to wrap the execution in CorrelationContext at all.
  const resolveCorrelationId: Effect.Effect<
    string | null,
    CommandApiBadRequest,
    HttpServerRequest.HttpServerRequest
  > = Effect.gen(function* () {
    if (!correlationHeaderEnabled) return null;
    const request = yield* HttpServerRequest.HttpServerRequest;
    const raw = request.headers[CORRELATION_HEADER];
    if (raw === undefined) return crypto.randomUUID();
    const decoded = Schema.decodeUnknownEither(Schema.UUID)(raw);
    if (decoded._tag === "Left") {
      return yield* Effect.fail(CommandApiBadRequest.of("Invalid X-Correlation-Id header"));
    }
    return decoded.right;
  });

  const CommandsLive = HttpApiBuilder.group(api, "commands", (handlers) =>
    handlers
      .handle("listExposedCommands", () => listExposedCommands)
      .handle("executeCommand", ({ payload }) =>
        Effect.gen(function* () {
          const entry = commands[payload.commandType];
          if (!entry) {
            return yield* Effect.fail(CommandApiBadRequest.of(`Unknown command type: ${payload.commandType}`));
          }

          const command = yield* Schema.decodeUnknown(entry.schema)(payload.command).pipe(
            Effect.catchTag("ParseError", () =>
              Effect.fail(CommandApiBadRequest.of(`Invalid payload for commandType: ${payload.commandType}`))
            )
          );

          const correlationId = yield* resolveCorrelationId;

          const executor = yield* CommandExecutor;
          // Only the command-execution call itself runs inside CorrelationContext - request
          // parsing/validation above (commandType lookup, payload decode, header validation)
          // deliberately does not. `catchTag("ConcurrencyException", ...)` is the one mapping
          // that needs to run *before* the terminal `toProblemDetail` normalization below, since
          // it carries real DCBViolation detail (violationCode/matchingEventsCount) that a generic
          // 500 fallback would lose.
          const runExecute = executor.execute(payload.commandType, command, entry.handler).pipe(
            Effect.catchTag("ConcurrencyException", (e: ConcurrencyException) => {
              const v = e.violation;
              return Effect.fail(
                v === null
                  ? CommandConflict.of(e.message, "CONCURRENCY_VIOLATION", 0)
                  : CommandConflict.of(e.message, v.errorCode, v.matchingEventsCount)
              );
            })
          );

          const result = yield* (correlationId !== null
            ? CorrelationContext.withCorrelationId(correlationId)(runExecute)
            : runExecute);

          const response = yield* HttpServerResponse.json(
            result.wasIdempotent
              ? { status: "IDEMPOTENT" as const, reason: result.reason }
              : { status: "CREATED" as const, reason: null },
            { status: result.wasIdempotent ? 200 : 201 }
          );

          return correlationId !== null ? HttpServerResponse.setHeader(response, CORRELATION_HEADER, correlationId) : response;
        }).pipe(
          Effect.catchAll((error) => Effect.fail(toProblemDetail(error))),
          Effect.catchAllDefect((defect) => Effect.fail(toProblemDetail(defect)))
        )
      )
  );

  return HttpApiBuilder.api(api).pipe(Layer.provide(CommandsLive));
};
