import { Effect, Layer } from "effect";
import * as Schema from "effect/Schema";
import type { HttpApi, HttpApiGroup } from "@effect/platform";
import { HttpApiBuilder, HttpServerRequest, HttpServerResponse } from "@effect/platform";
import { CommandExecutor } from "@crablet/commands";
import * as CorrelationContext from "@crablet/eventstore/CorrelationContext";
import type { ConcurrencyException } from "@crablet/eventstore/DCBViolation";
import { makeCommandApi, CommandEnvelope } from "./CommandApi.ts";
import type { ExposedCommand } from "./ExposedCommand.ts";

type CommandEnvelopePayload = Schema.Schema.Type<typeof CommandEnvelope>;
import type { CommandApiConfig } from "./CommandApiConfig.ts";
import { defaultBasePath } from "./CommandApiConfig.ts";
import { CommandApiBadRequest, CommandConflict, CommandApiUnexpectedError } from "./ProblemDetail.ts";

// Duck-typed on the RFC 7807 shape (type/title/status/detail) rather than `instanceof` against a
// fixed list of known classes - this is what lets ExposedCommand.ts's per-command `mapError` hook
// surface an app-owned domain-error class (e.g. examples/wallet-example-app's own
// WalletNotFoundProblem) without commands-http needing to know that class exists. Anything that
// doesn't already look like a ProblemDetail (a framework-internal decode/encode error, an
// unrecognized handler-thrown value, ...) becomes a generic 500 - the same terminal
// "catch-all Exception -> 500, message not echoed" safety net Java's CommandApiExceptionHandler
// applies, rather than trying to enumerate every possible error type by hand.
const isProblemDetailShaped = (value: unknown): value is object =>
  typeof value === "object" &&
  value !== null &&
  "type" in value &&
  "title" in value &&
  "status" in value &&
  "detail" in value;

const toProblemDetail = (error: unknown): object => (isProblemDetailShaped(error) ? error : CommandApiUnexpectedError.instance);

const CORRELATION_HEADER = "x-correlation-id";

// Port of com.crablet.command.web.internal.CommandApiRestController.executeCommand +
// CommandApiExceptionHandler. `commands` is the app-supplied flat map replacing Java's two-tier
// reflection registry (see ExposedCommand.ts's primer) - each entry keeps its own concrete T/E, so
// the map itself is type-erased at this boundary the same way AutomationEventHandler.ts's
// registry is.
//
// Takes the full composed `api` as a parameter (generic over whatever bigger `HttpApi` the caller
// built, as long as it contains a `"commands"` group shaped like `makeCommandApiGroup` produces)
// rather than building it internally - this is what lets a consuming app compose this group
// alongside its own groups (e.g. a read-only query API) under one shared `HttpApiBuilder.serve()`,
// instead of only being usable standalone. Returns just the group's implementation Layer, same as
// `HttpApiBuilder.group` itself does - wrapping it in `HttpApiBuilder.api(...)` is the caller's own
// job (see `makeCommandApiLive` below for the standalone case).
export const makeCommandApiGroupLive = <
  ApiId extends string,
  Groups extends HttpApiGroup.HttpApiGroup.Any,
  ApiError,
  ApiR
>(
  api: HttpApi.HttpApi<ApiId, Groups, ApiError, ApiR>,
  // `Record<string, ExposedCommand<any, any>>` - see ExposedCommand.ts's primer on why this
  // registry is type-erased at this boundary, never in the public per-entry API.
  commands: Readonly<Record<string, ExposedCommand<any, any>>>,
  config: CommandApiConfig = {}
  // Explicit return type: the `any` cast below (needed to call HttpApiBuilder.group against an
  // arbitrary caller-supplied `Groups`) would otherwise widen this function's inferred R to
  // `unknown`, silently discarding the real `CommandExecutor | ApiR` requirement callers (and this
  // package's own existing tests) rely on to typecheck their own composition root. The output
  // (`Layer<A, ...>`) type param is left as `any` rather than hand-deriving
  // HttpApiBuilder.group's own precise `HttpApiGroup.ApiGroup<Id, Name>` output type - only the
  // error/requirement channels matter to callers here, since this Layer is always immediately fed
  // into `Layer.provide(...)`, never inspected for its own output shape.
): Layer.Layer<any, never, ApiR | CommandExecutor> => {
  const correlationHeaderEnabled = config.correlationHeaderEnabled ?? false;

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

  // `HttpApiBuilder.group as any`: its own signature requires "commands" to be statically known as
  // a member of `Groups`, which an arbitrary caller-supplied generic `Groups` can't prove to the
  // compiler (that's the whole point of accepting *any* bigger api that happens to contain this
  // group at runtime) - casting just the `api` argument still let generic inference collapse
  // `Groups` to `never` in a way that rejected the literal group/endpoint-name strings below, so
  // the whole call is cast instead. Narrow, deliberate type-erasure at this one
  // dynamic-composition boundary - `payload`'s shape is recovered immediately below via
  // `CommandEnvelopePayload`, so nothing downstream loses type safety.
  const groupBuilder = HttpApiBuilder.group as any;
  const CommandsLive = groupBuilder(api, "commands", (handlers: any) =>
    handlers
      .handle("listExposedCommands", () => listExposedCommands)
      .handle("executeCommand", ({ payload }: { payload: CommandEnvelopePayload }) =>
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
          // deliberately does not. `catchTag("ConcurrencyException", ...)` carries real
          // DCBViolation detail (violationCode/matchingEventsCount) into CommandConflict, which
          // must happen before the entry's own `mapError` hook - a ConcurrencyException is never
          // this command's own domain error. Everything else remaining (the handler's own E) gets
          // one chance via `entry.mapError` to become a real ProblemDetail (e.g. "wallet not
          // found" -> 404) before falling through, unchanged, to the outer terminal
          // `toProblemDetail` catch-all.
          const runExecute = executor.execute(payload.commandType, command, entry.handler).pipe(
            Effect.catchTag("ConcurrencyException", (e: ConcurrencyException) => {
              const v = e.violation;
              return Effect.fail(
                v === null
                  ? CommandConflict.of(e.message, "CONCURRENCY_VIOLATION", 0)
                  : CommandConflict.of(e.message, v.errorCode, v.matchingEventsCount)
              );
            }),
            Effect.catchAll((error) =>
              error instanceof CommandConflict ? Effect.fail(error) : Effect.fail(entry.mapError?.(error) ?? error)
            )
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

  return CommandsLive;
};

// Standalone convenience wrapper, unchanged behavior from before this file's composability
// refactor - builds its own complete `HttpApi` internally and wraps the group layer in
// `HttpApiBuilder.api(...)` itself, for callers (and this package's own existing tests) that just
// want a ready-to-serve Layer without composing anything else alongside it.
export const makeCommandApiLive = (
  commands: Readonly<Record<string, ExposedCommand<any, any>>>,
  config: CommandApiConfig = {}
) => {
  const basePath = (config.basePath ?? defaultBasePath) as `/${string}`;
  const api = makeCommandApi(basePath);
  return HttpApiBuilder.api(api).pipe(Layer.provide(makeCommandApiGroupLive(api, commands, config)));
};
