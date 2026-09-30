import { Context, Effect, Layer, Metric } from "effect";
import { SqlClient } from "effect/sql";
import type { SqlError } from "effect/sql/SqlError";
import { EventStore } from "@crablet/eventstore";
import { CommandAuditStore } from "@crablet/eventstore/CommandAuditStore";
import { Conflict, Duplicate } from "@crablet/eventstore/AppendErrors";
import * as CommandMetrics from "@crablet/metrics-otel/CommandMetrics";
import type { Command } from "./Command.ts";
import type * as CD from "./CommandDecision.ts";
import type { InvalidInput } from "./Errors.ts";
import * as ExecutionResultNS from "./ExecutionResult.ts";
import type { ExecutionResult } from "./ExecutionResult.ts";

// A command handler turns a command into a decision ("append these events under this condition", or
// "nothing to do"). The event store is ambient (via Effect's context), not an explicit parameter.
export type CommandHandler<T, E = never> = (command: T) => Effect.Effect<CD.CommandDecision, E, EventStore>;

// `commandType` is caller-supplied because commands are plain objects (no class name to derive it
// from); it exists to tag CommandMetrics, not to look up a handler - callers always pass the
// handler explicitly (see ADR-0008, no auto-discovery).
//
// Failure modes of `execute`: the handler's own `E`; `Conflict` (the decision went stale - the
// concurrency check refused the append); `Duplicate` (the idempotency check matched AND the decision's
// `onDuplicate` is "THROW" - with the default "RETURN_IDEMPOTENT" it is reported as an idempotent
// success instead, so this failure only occurs when a command opted in); and database errors.
export interface CommandExecutorService {
  readonly execute: <T, E>(
    commandType: string,
    command: T,
    handler: CommandHandler<T, E>
  ) => Effect.Effect<
    ExecutionResult,
    E | Conflict | Duplicate | SqlError,
    EventStore | CommandAuditStore | SqlClient.SqlClient
  >;

  // Run a defined command (see Command.ts). `run` takes UNTRUSTED input: it is validated against the
  // command's schema first (`InvalidInput`). `runDecoded` takes input that is already the command's
  // typed input (e.g. built by an automation) and skips validation.
  //
  // Both re-run the whole command - a fresh transaction and a fresh load - up to `command.retries`
  // times when the append is refused with `Conflict` (a peer changed something in the boundary since
  // this run loaded it); `decide` is pure and the transaction rolled back, so retrying is safe. Only a
  // `Conflict` is retried, and the last one is reported if the retries run out. `Duplicate` can only
  // fail a command that declared `onDuplicate: "fail"`; otherwise a repeat is an idempotent success.
  readonly run: <In, Err>(
    command: Command<In, Err>,
    input: unknown
  ) => Effect.Effect<
    ExecutionResult,
    Err | InvalidInput | Conflict | SqlError,
    EventStore | CommandAuditStore | SqlClient.SqlClient
  >;
  readonly runDecoded: <In, Err>(
    command: Command<In, Err>,
    input: In
  ) => Effect.Effect<
    ExecutionResult,
    Err | Conflict | SqlError,
    EventStore | CommandAuditStore | SqlClient.SqlClient
  >;
}

export class CommandExecutor extends Context.Service<CommandExecutor, CommandExecutorService>()("CommandExecutor") {}

export const CommandExecutorLive = Layer.effect(
  CommandExecutor,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;

    const execute = <T, E>(
      commandType: string,
      command: T,
      handler: CommandHandler<T, E>
    ): Effect.Effect<
      ExecutionResult,
      E | Conflict | Duplicate | SqlError,
      EventStore | CommandAuditStore | SqlClient.SqlClient
    > =>
      // sql.withTransaction(effect) runs `effect` inside one Postgres transaction, committing on
      // success and rolling back on any failure (including interruption). Because effect/sql makes the
      // "current" SqlClient ambient, the `EventStore`/`CommandAuditStore` obtained via `yield*`
      // *inside* this block automatically use the transaction-scoped connection, so one EventStore
      // implementation serves both standalone and transactional use (ADR-0002).
      //
      // Wrapped with CommandMetrics.observe for the handle.duration/successes/failures triplet, plus a
      // dedicated idempotentDuplicates increment when the result comes back idempotent.
      CommandMetrics.observe(
        CommandMetrics.handle,
        sql.withTransaction(
          Effect.gen(function* () {
            const eventStore = yield* EventStore;
            const decision = yield* handler(command);

            if (decision._tag === "NoOp") {
              return ExecutionResultNS.idempotent(decision.reason ?? "DUPLICATE_OPERATION");
            }

            // One atomic conditional append for every kind of decision. The idempotency check runs
            // before the concurrency check inside the SQL function, so an idempotent retry against a
            // since-changed state is a duplicate, not a spurious conflict.
            const outcome = yield* eventStore.append(decision.events, decision.condition).pipe(
              Effect.as("created" as const),
              Effect.catchTag("Conflict", (conflict) =>
                // A lifecycle-guard decision reports its conflict as a guard conflict.
                Effect.fail(
                  decision.conflictKind === "guard"
                    ? new Conflict({
                        message: "Lifecycle guard violated: lifecycle state changed since it was loaded",
                        kind: "guard"
                      })
                    : conflict
                )
              ),
              Effect.catchTag("Duplicate", (duplicate) =>
                decision.onDuplicate === "THROW" ? Effect.fail(duplicate) : Effect.succeed("idempotent" as const)
              )
            );

            return outcome === "idempotent"
              ? ExecutionResultNS.idempotent("DUPLICATE_OPERATION")
              : ExecutionResultNS.created();
          })
        ).pipe(
          Effect.tap((result) => {
            if (!result.wasIdempotent) return Effect.void;
            const taggedCounter: Metric.Counter<number> = Metric.withAttributes(
              CommandMetrics.idempotentDuplicates,
              { command_type: commandType }
            );
            return Metric.update(taggedCounter, 1);
          })
        ),
        [["command_type", commandType]]
      );

    // Execute, re-running after a Conflict while retries remain (each attempt is its own transaction).
    const runDecoded = <In, Err>(command: Command<In, Err>, input: In) => {
      const attempt = (
        retriesUsed: number
      ): Effect.Effect<
        ExecutionResult,
        Err | SqlError | Conflict | Duplicate,
        EventStore | CommandAuditStore | SqlClient.SqlClient
      > =>
        execute(command.name, input, command.handler).pipe(
          Effect.catchTag("Conflict", (conflict) =>
            retriesUsed < command.retries
              ? Effect.andThen(
                  Metric.update(
                    Metric.withAttributes(CommandMetrics.conflictRetries, { command_type: command.name }),
                    1
                  ),
                  attempt(retriesUsed + 1)
                )
              : Effect.fail(conflict)
          )
        );
      // The executor reports `Duplicate` for every command, but only a command that declared
      // `onDuplicate: "fail"` can produce one that should reach the caller: for any other command the
      // executor has already turned it into an idempotent success, so none can arrive here.
      return attempt(0).pipe(
        Effect.catchTag("Duplicate", (duplicate) =>
          command.duplicates === "fail" ? Effect.fail(duplicate) : Effect.die(duplicate)
        )
      ) as Effect.Effect<
        ExecutionResult,
        Err | Conflict | SqlError,
        EventStore | CommandAuditStore | SqlClient.SqlClient
      >;
    };

    const run = <In, Err>(command: Command<In, Err>, input: unknown) =>
      Effect.flatMap(command.decodeInput(input), (decoded) => runDecoded(command, decoded));

    const service: CommandExecutorService = { execute, run, runDecoded };
    return service;
  })
);
