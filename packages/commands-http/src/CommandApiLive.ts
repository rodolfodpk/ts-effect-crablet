import { Duration, Effect, Layer } from "effect";
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
import { defaultWaitTimeoutMs, maxWaitTimeoutMs, type ViewWaiter } from "./ViewWaiter.ts";
import { kindOf, type InputIssue } from "@crablet/commands/Errors";
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

  const viewWaiters = config.viewWaiters ?? {};
  const waitableViews = Object.keys(viewWaiters);

  // `?waitFor=<view>` and `?waitTimeout=<ms>`: validated BEFORE the command runs, so a bad parameter can never
  // leave an executed command behind an error response.
  const parseWait = (
    request: HttpServerRequest.HttpServerRequest
  ): Effect.Effect<{ readonly name: string; readonly waiter: ViewWaiter; readonly timeoutMs: number } | null, CommandApiBadRequest> => {
    const params = new URL(request.url, "http://localhost").searchParams;
    const name = params.get("waitFor");
    const timeoutRaw = params.get("waitTimeout");
    if (name === null && timeoutRaw === null) return Effect.succeed(null);
    if (name === null) return Effect.fail(CommandApiBadRequest.of("waitTimeout needs waitFor"));
    const waiter = Object.hasOwn(viewWaiters, name) ? viewWaiters[name] : undefined;
    if (waiter === undefined) {
      return Effect.fail(
        CommandApiBadRequest.of(`Unknown view for waitFor: ${name}${waitableViews.length > 0 ? ` (one of: ${waitableViews.join(", ")})` : " (no views can be waited for)"}`)
      );
    }
    const timeoutMs = timeoutRaw === null ? defaultWaitTimeoutMs : /^\d+$/.test(timeoutRaw) ? Number(timeoutRaw) : NaN;
    if (!(timeoutMs >= 1 && timeoutMs <= maxWaitTimeoutMs)) {
      return Effect.fail(CommandApiBadRequest.of(`waitTimeout must be a whole number of milliseconds between 1 and ${maxWaitTimeoutMs}`));
    }
    return Effect.succeed({ name, waiter, timeoutMs });
  };

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
      const invalidPayload = (issues?: ReadonlyArray<InputIssue>) => CommandApiBadRequest.of(`Invalid payload for command: ${commandType}`, issues);
      const raw = yield* request.json.pipe(Effect.mapError(() => invalidPayload()));
      // Validation belongs to the command itself: its input schema. Every failed field is reported, by path.
      const input = yield* entry.command.decodeInput(raw).pipe(Effect.mapError((error) => invalidPayload(error.issues)));

      const wait = yield* parseWait(request);
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

      // The command is done. If the request asked to wait for a view, wait for it to catch up to this write; the
      // outcome is reported in the body, never as an error status (retrying a command that succeeded would be
      // wrong). An idempotent repeat appended nothing, so there is nothing to wait for.
      const view =
        wait === null
          ? undefined
          : result.lastPosition === null || result.lastTransactionId === null
            ? { name: wait.name, caughtUp: false, reason: "nothing_appended" as const }
            : yield* wait.waiter({ transactionId: result.lastTransactionId, position: result.lastPosition }, { timeout: Duration.millis(wait.timeoutMs) }).pipe(
                Effect.match({
                  onSuccess: () => ({ name: wait.name, caughtUp: true }),
                  onFailure: (e) => ({
                    name: wait.name,
                    caughtUp: false,
                    reason: e._tag === "WaitTimeout" ? ("timeout" as const) : e._tag === "ViewFailed" ? ("view_failed" as const) : ("unavailable" as const)
                  })
                })
              );

      // Raw response: the status (201 created / 200 idempotent) and optional correlation header are
      // chosen here, after the command ran.
      return HttpServerResponse.jsonUnsafe(
        result.wasIdempotent
          ? { status: "IDEMPOTENT" as const, reason: result.reason, lastPosition: null, ...(view !== undefined ? { view } : {}) }
          : { status: "CREATED" as const, reason: null, lastPosition: String(result.lastPosition), ...(view !== undefined ? { view } : {}) },
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
  const api = makeCommandApi(basePath, commands, undefined, { waitableViews: Object.keys(config.viewWaiters ?? {}) });
  return Layer.merge(
    HttpApiBuilder.layer(api, apiLayerOptions(config)).pipe(Layer.provide(makeCommandApiGroupLive(api, commands, config))),
    apiDocsLayer(api, config)
  );
};
