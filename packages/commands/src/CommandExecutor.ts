import { Context, Effect, Layer, Metric, Schedule } from "effect";
import { SqlClient } from "effect/sql";
import type { SqlError } from "effect/sql/SqlError";
import { EventStore } from "@crablet/eventstore";
import { CommandAuditStore } from "./CommandAuditStore.ts";
import * as CorrelationContext from "@crablet/eventstore/CorrelationContext";
import { type AppendTooLarge, Conflict } from "@crablet/eventstore/AppendErrors";
import * as CommandMetrics from "@crablet/metrics-otel/CommandMetrics";
import type { Command, RawInput } from "./Command.ts";
import { recordCommand } from "./CommandAudit.ts";
import { reportExecution } from "./CommandOutcome.ts";
import type * as CD from "./CommandDecision.ts";
import { IdempotencyMismatch, type InvalidInput } from "./Errors.ts";
import { isSameRequest } from "./Repeat.ts";
import * as ExecutionResultNS from "./ExecutionResult.ts";
import type { ExecutionResult } from "./ExecutionResult.ts";
import type { InputSchema } from "./Contract.ts";

// A command handler turns a command into a decision ("append these events under this condition", or
// "nothing to do"). The event store is ambient (via Effect's context), not an explicit parameter.
export type CommandHandler<T, E = never> = (command: T) => Effect.Effect<CD.CommandDecision, E, EventStore>;

// Commands are always run explicitly - there is no command-type auto-discovery (ADR-0008).
//
// `run` and `runDecoded` need nothing from their caller: the executor resolves its event store, audit store and SQL client when its layer is
// built, as `EventStore` and `CommandAuditStore` resolve theirs. What a call still reads from the caller's context are the references with a
// default (the correlation and causation ids, the actor, the audit setting), which are per request, not dependencies.
export interface CommandExecutorService {
  // Run a defined command (see Command.ts). `run` takes the input before decoding (`RawInput`, typed from the command's schema, so a
  // misspelt field does not compile) and still validates it at run time (`InvalidInput`): checks such as `isGreaterThanOrEqualTo` are not types. `runDecoded` takes input that is already the command's
  // typed input (e.g. built by an automation) and skips validation.
  //
  // Both re-run the whole command - a fresh transaction and a fresh load - up to `command.retries`
  // times when the append is refused with `Conflict` (a peer changed something in the boundary since
  // this run loaded it); `decide` is pure and the transaction rolled back, so retrying is safe. Only a
  // `Conflict` is retried, and the last one is reported if the retries run out. A repeat that
  // `idempotentBy` finds is an idempotent success.
  readonly run: <In, Err, I extends InputSchema>(
    command: Command<In, Err, I>,
    input: RawInput<I>
  ) => Effect.Effect<ExecutionResult, Err | InvalidInput | AppendTooLarge | Conflict | IdempotencyMismatch | SqlError>;
  readonly runDecoded: <In, Err>(
    command: Command<In, Err>,
    input: In
  ) => Effect.Effect<ExecutionResult, Err | AppendTooLarge | Conflict | IdempotencyMismatch | SqlError>;
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
  command: T,
  // The command's name, for the message of an `IdempotencyMismatch` found at the append.
  name = "command"
): Effect.Effect<ExecutionResult, E | AppendTooLarge | Conflict | IdempotencyMismatch | SqlError, EventStore> =>
  Effect.gen(function* () {
    const eventStore = yield* EventStore;
    const decision = yield* handler(command);

    if (decision._tag === "NoOp") {
      return ExecutionResultNS.idempotent(decision.reason ?? "DUPLICATE_OPERATION", decision.marker ?? null);
    }

    const fingerprint = decision.requestFingerprint ?? null;
    const causationId = yield* CorrelationContext.causationId;
    const outcome = yield* CorrelationContext.withRequestFingerprint(fingerprint)(eventStore.append(decision.events, decision.condition)).pipe(
      Effect.map((appended) => ({ marker: { position: appended.lastPosition, transactionId: appended.transactionId } })),
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
      // The idempotency query matched at the append (a request that committed between the pre-check and here): the same request is "already
      // done", with the earlier write's marker; another request under the same key is refused (ADR-0034).
      Effect.catchTag("Duplicate", (duplicate): Effect.Effect<Repeat, IdempotencyMismatch> =>
        isSameRequest(duplicate, fingerprint, causationId)
          ? duplicate.byTrigger
            ? // The backstop caught what idempotentBy did not: the same trigger, the same request, again. Already done, but the key is wrong (ADR-0035).
              Effect.logWarning(`command "${name}": a redelivered trigger (position ${causationId}) was stopped by the framework's backstop, not by its idempotentBy, which does not recognise its own repeat`).pipe(
                Effect.as({ repeat: duplicate.latest, reason: "ALREADY_DONE_FOR_TRIGGER" })
              )
            : Effect.succeed({ repeat: duplicate.latest, reason: "DUPLICATE_OPERATION" })
          : Effect.fail(new IdempotencyMismatch({
              command: name,
              message: `command "${name}": this request's key was already used by a different request; the earlier one stands and this one was not applied`
            }))
      )
    );

    return "repeat" in outcome ? ExecutionResultNS.idempotent(outcome.reason, outcome.repeat) : ExecutionResultNS.created(outcome.marker);
  });

// An append the key found already done: where the earlier write is, and why (ExecutionResult.reason).
interface Repeat {
  readonly repeat: { readonly position: bigint; readonly transactionId: string };
  readonly reason: "DUPLICATE_OPERATION" | "ALREADY_DONE_FOR_TRIGGER";
}

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

// A command makes one append, whose writer locks (ADR-0003) are taken in sorted order, so two commands cannot deadlock each other. An
// application transaction that appends several times in its own order can still deadlock with a command; Postgres aborts one of them
// (SQLSTATE 40P01, deadlock_detected) and rolls its transaction back. When that is the command, it is exactly the situation a
// `Conflict` retry handles: the whole command is re-run in a fresh transaction (test/integration/deadlock-retry.test.ts).
const isDeadlock = (error: unknown): boolean =>
  typeof error === "object" &&
  error !== null &&
  "_tag" in error &&
  error._tag === "SqlError" &&
  ((error as SqlError).reason.cause as { code?: string } | null | undefined)?.code === "40P01";
const deadlockConflict = new Conflict({ message: "Deadlock detected between concurrent commands; the transaction was rolled back", kind: "boundary" });

// Needs the `EventStore` and the `CommandAuditStore` when it is built (and the `SqlClient` they share), so it is provided WITH them, not merged
// beside them: `Layer.provideMerge(CommandExecutorLive, Layer.mergeAll(eventStoreLayer, CommandAuditStoreLive))`, as `Crablet.layer` does.
export const CommandExecutorLive = Layer.effect(
  CommandExecutor,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const eventStore = yield* EventStore;
    const commandAuditStore = yield* CommandAuditStore;

    // What the handler (it reads through `EventStore`) and the audit record need, from the layer instead of from the caller.
    const withServices = <A, E>(effect: Effect.Effect<A, E, EventStore | CommandAuditStore | SqlClient.SqlClient>): Effect.Effect<A, E> =>
      effect.pipe(
        Effect.provideService(EventStore, eventStore),
        Effect.provideService(CommandAuditStore, commandAuditStore),
        Effect.provideService(SqlClient.SqlClient, sql)
      );

    // One attempt: the handler and its append inside one transaction.
    const execute = <T, E>(
      definition: Command<T, E>,
      command: T,
      handler: CommandHandler<T, E>
    ): Effect.Effect<ExecutionResult, E | AppendTooLarge | Conflict | IdempotencyMismatch | SqlError> =>
      // sql.withTransaction(effect) runs `effect` inside one Postgres transaction, committing on
      // success and rolling back on any failure (including interruption). The transaction is carried in
      // the fiber's context (`sql.transactionService`), not in which SqlClient value is used, so the event
      // store and the audit store captured above, which hold the same `sql`, write on the transaction's
      // connection: one EventStore implementation serves both standalone and transactional use (ADR-0002).
      //
      // Wrapped with CommandMetrics.observe for the handle.duration/successes/failures triplet, plus a
      // dedicated idempotentDuplicates increment when the result comes back idempotent.
      CommandMetrics.observe(
        CommandMetrics.handle,
        // The wake-up for what the attempt appended goes out only after this transaction has committed (ADR-0021).
        // `requireFreshTransaction`: the append must be this transaction's first write, so its events sort after everything the command read (ADR-0033).
        withServices(eventStore.withWakeups(sql.withTransaction(CorrelationContext.requireFreshTransaction(
          Effect.gen(function* () {
            const result = yield* runHandler(handler, command, definition.name);
            // An idempotent result (a repeat, or a decision that does nothing) has done nothing, so nothing of this attempt may stay: roll the transaction back. A command cannot append
            // before its decision (`resolve` only reads), so today there is nothing to undo; the rollback keeps it that way if that ever changes, because an idempotent result writes no
            // audit row and anything committed would have no command behind it. The failure is caught just below, outside the wake-up.
            if (result.wasIdempotent) return yield* Effect.fail(new RolledBackIdempotent(result));
            // A command that appended events leaves an audit row IN THE SAME transaction (see CommandAudit.ts):
            // a rolled-back command leaves no row.
            yield* recordCommand(definition, command);
            return result;
          })
        )).pipe(
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
          }),
          Effect.tapError((error) =>
            error instanceof IdempotencyMismatch
              ? Metric.update(Metric.withAttributes(CommandMetrics.idempotencyMismatches, { command_type: definition.name }), 1)
              : Effect.void
          )
        ),
        [["command_type", definition.name]]
      );

    // Execute, re-running after a Conflict while retries remain (each attempt is its own transaction).
    const runDecoded = <In, Err>(command: Command<In, Err>, input: In) =>
      // The `crablet.command` span and the outcome metrics (CommandOutcome.ts, ADR-0056): one execution, its retries inside it.
      reportExecution(command, (attempt) =>
        withConflictRetry(
          command.retries,
          attempt(execute(command, input, command.handler)),
          Metric.update(Metric.withAttributes(CommandMetrics.conflictRetries, { command_type: command.name }), 1)
        )
      ).pipe(Effect.annotateLogs({ command: command.name }));

    const run = <In, Err, I extends InputSchema>(command: Command<In, Err, I>, input: RawInput<I>) =>
      Effect.flatMap(command.decodeInput(input), (decoded) => runDecoded(command, decoded));

    const service: CommandExecutorService = { run, runDecoded };
    return service;
  })
);
