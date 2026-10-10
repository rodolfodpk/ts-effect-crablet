import { Context, Effect, Layer, Metric, Schedule } from "effect";
import { SqlClient } from "effect/sql";
import type { SqlError } from "effect/sql/SqlError";
import { EventStore } from "@crablet/eventstore";
import { CommandAuditStore } from "@crablet/eventstore/CommandAuditStore";
import { type AppendTooLarge, Conflict, Duplicate } from "@crablet/eventstore/AppendErrors";
import * as CommandMetrics from "@crablet/metrics-otel/CommandMetrics";
import type { Command } from "./Command.ts";
import { recordCommand } from "./CommandAudit.ts";
import type * as CD from "./CommandDecision.ts";
import type { InvalidInput } from "./Errors.ts";
import * as ExecutionResultNS from "./ExecutionResult.ts";
import type { ExecutionResult } from "./ExecutionResult.ts";

// A command handler turns a command into a decision ("append these events under this condition", or
// "nothing to do"). The event store is ambient (via Effect's context), not an explicit parameter.
export type CommandHandler<T, E = never> = (command: T) => Effect.Effect<CD.CommandDecision, E, EventStore>;

// Commands are always run explicitly - there is no command-type auto-discovery (ADR-0008).
export interface CommandExecutorService {
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
    Err | InvalidInput | AppendTooLarge | Conflict | SqlError,
    EventStore | CommandAuditStore | SqlClient.SqlClient
  >;
  readonly runDecoded: <In, Err>(
    command: Command<In, Err>,
    input: In
  ) => Effect.Effect<
    ExecutionResult,
    Err | AppendTooLarge | Conflict | SqlError,
    EventStore | CommandAuditStore | SqlClient.SqlClient
  >;
}

export class CommandExecutor extends Context.Service<CommandExecutor, CommandExecutorService>()("CommandExecutor") {}

// Carries an idempotent result out of the transaction that is rolled back for it (see `execute`); never reaches a caller.
class RolledBackIdempotent {
  readonly _tag = "RolledBackIdempotent";
  readonly result: ExecutionResult;
  constructor(result: ExecutionResult) {
    this.result = result;
  }
}

// The part of running a command that does not depend on HOW transactions are provided: call the
// handler, then apply its decision with ONE atomic conditional append. Exported so other runners (the
// in-memory scenario runner in testing/) share exactly this logic instead of copying it.
//
// The idempotency check runs before the concurrency check inside the append, so an idempotent retry
// against a since-changed state is a duplicate, not a spurious conflict.
export const runHandler = <T, E>(
  handler: CommandHandler<T, E>,
  command: T
): Effect.Effect<ExecutionResult, E | AppendTooLarge | Conflict | Duplicate | SqlError, EventStore> =>
  Effect.gen(function* () {
    const eventStore = yield* EventStore;
    const decision = yield* handler(command);

    if (decision._tag === "NoOp") {
      return ExecutionResultNS.idempotent(decision.reason ?? "DUPLICATE_OPERATION");
    }

    const outcome = yield* eventStore.append(decision.events, decision.condition).pipe(
      Effect.map((appended) => ({ lastPosition: appended.lastPosition, transactionId: appended.transactionId })),
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

    return outcome === "idempotent" ? ExecutionResultNS.idempotent("DUPLICATE_OPERATION") : ExecutionResultNS.created(outcome.lastPosition, outcome.transactionId);
  });

// Re-run `attempt` after a `Conflict`, up to `retries` more times (`onRetry` runs before each re-run).
// Each re-run is a fresh attempt: the caller makes `attempt` a whole new transaction with a fresh load.
// The last `Conflict` is reported if the retries run out; any other failure is not retried.
export const withConflictRetry = <A, E, R>(
  retries: number,
  attempt: Effect.Effect<A, E, R>,
  onRetry: Effect.Effect<void> = Effect.void
): Effect.Effect<A, E, R> =>
  Effect.retry(
    attempt,
    // at most `retries` more runs; only while the failure is a Conflict; `onRetry` runs once before each re-run (and never after the last failure)
    Schedule.recurs(retries).pipe(
      Schedule.while(({ input }) => input instanceof Conflict),
      Schedule.tap(() => onRetry)
    )
  );

// Two commands that each make several appends can acquire the append locks of different entities in
// opposite order (V5 writer-side locking). Postgres aborts one of them (SQLSTATE 40P01, deadlock_detected)
// and rolls its transaction back - exactly the situation a `Conflict` retry handles: the whole command is
// re-run in a fresh transaction.
const isDeadlock = (error: unknown): boolean =>
  typeof error === "object" &&
  error !== null &&
  "_tag" in error &&
  error._tag === "SqlError" &&
  ((error as SqlError).reason.cause as { code?: string } | null | undefined)?.code === "40P01";
const deadlockConflict = new Conflict({ message: "Deadlock detected between concurrent commands; the transaction was rolled back", kind: "boundary" });

export const CommandExecutorLive = Layer.effect(
  CommandExecutor,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;

    // One attempt: the handler and its append inside one transaction. `Duplicate` is reported here for
    // every command; `runDecoded` turns it into an idempotent success unless the command opted in.
    const execute = <T, E>(
      definition: Command<T, E>,
      command: T,
      handler: CommandHandler<T, E>
    ): Effect.Effect<
      ExecutionResult,
      E | AppendTooLarge | Conflict | Duplicate | SqlError,
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
        // The wake-up for what the attempt appended goes out only after this transaction has committed (ADR-0021).
        Effect.flatMap(EventStore, (eventStore) => eventStore.withWakeups(sql.withTransaction(
          Effect.gen(function* () {
            const result = yield* runHandler(handler, command);
            // An idempotent result (a repeat, or a decision that does nothing) has done nothing, so nothing of this attempt may stay: roll the transaction back, `prepare`'s appends included.
            // Committing it would leave those events with no command behind them, because an idempotent result writes no audit row. The failure is caught just below, outside the wake-up.
            if (result.wasIdempotent) return yield* Effect.fail(new RolledBackIdempotent(result));
            // A command that appended events leaves an audit row IN THE SAME transaction (see CommandAudit.ts):
            // a rolled-back command leaves no row.
            yield* recordCommand(definition, command);
            return result;
          })
        ).pipe(
          Effect.catch((error) => (isDeadlock(error) ? Effect.fail(deadlockConflict) : Effect.fail(error)))
        ))).pipe(
          Effect.catch((error) => (error instanceof RolledBackIdempotent ? Effect.succeed(error.result) : Effect.fail(error))),
          Effect.tap((result) => {
            if (!result.wasIdempotent) return Effect.void;
            const taggedCounter: Metric.Counter<number> = Metric.withAttributes(
              CommandMetrics.idempotentDuplicates,
              { command_type: definition.name }
            );
            return Metric.update(taggedCounter, 1);
          })
        ),
        [["command_type", definition.name]]
      );

    // Execute, re-running after a Conflict while retries remain (each attempt is its own transaction).
    const runDecoded = <In, Err>(command: Command<In, Err>, input: In) =>
      withConflictRetry(
        command.retries,
        execute(command, input, command.handler),
        Metric.update(Metric.withAttributes(CommandMetrics.conflictRetries, { command_type: command.name }), 1)
        // The executor reports `Duplicate` for every command, but only a command that declared
        // `onDuplicate: "fail"` can produce one that should reach the caller: for any other command
        // the executor has already turned it into an idempotent success, so none can arrive here.
      ).pipe(
        Effect.catchTag("Duplicate", (duplicate) =>
          command.duplicates === "fail" ? Effect.fail(duplicate) : Effect.die(duplicate)
        ),
        // One span for the whole execution, retries included: the attempts and the appends inside it are its children, and its failure is the command's outcome.
        Effect.withSpan("crablet.command", { attributes: { "crablet.command.name": command.name, "crablet.command.max_retries": command.retries } }),
        Effect.annotateLogs({ command: command.name })
      ) as Effect.Effect<
        ExecutionResult,
        Err | AppendTooLarge | Conflict | SqlError,
        EventStore | CommandAuditStore | SqlClient.SqlClient
      >;

    const run = <In, Err>(command: Command<In, Err>, input: unknown) =>
      Effect.flatMap(command.decodeInput(input), (decoded) => runDecoded(command, decoded));

    const service: CommandExecutorService = { run, runDecoded };
    return service;
  })
);
