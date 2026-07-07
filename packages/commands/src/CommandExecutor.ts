import { Context, Effect, Layer, Metric } from "effect";
import { SqlClient } from "@effect/sql";
import type { SqlError } from "@effect/sql/SqlError";
import { EventStore, type EventStoreService } from "@crablet/eventstore";
import { CommandAuditStore } from "@crablet/eventstore/CommandAuditStore";
import { ConcurrencyException, type DCBViolation } from "@crablet/eventstore/DCBViolation";
import * as Query from "@crablet/eventstore/Query";
import * as AppendCondition from "@crablet/eventstore/AppendCondition";
import * as CommandMetrics from "@crablet/metrics-otel/CommandMetrics";
import * as CD from "./CommandDecision.ts";
import * as ExecutionResultNS from "./ExecutionResult.ts";
import type { ExecutionResult } from "./ExecutionResult.ts";

// Port of com.crablet.command.CommandHandler<T> - eventStore is ambient (via Effect's context),
// not an explicit parameter, so a handler is just "given a command, produce a decision."
export type CommandHandler<T, E = never> = (command: T) => Effect.Effect<CD.CommandDecision, E, EventStore>;

// Port of CommandExecutorImpl's per-decision-variant append dispatch. Command-type-string
// auto-discovery (Java's JSON `commandType` field lookup) and the command-level audit pre-check
// (COMMAND_ID-based idempotency) are deliberately out of scope for this port - callers always
// pass the handler explicitly (TS has no runtime-reflection equivalent to look one up by type).
// `commandType` below is caller-supplied for the same reason: TS commands are plain objects, not
// classes, so there's no `command.getClass().getSimpleName()` equivalent to derive it from - it
// exists purely to tag CommandMetrics, not to look up a handler.
export interface CommandExecutorService {
  readonly execute: <T, E>(
    commandType: string,
    command: T,
    handler: CommandHandler<T, E>
  ) => Effect.Effect<ExecutionResult, E | ConcurrencyException | SqlError, EventStore | CommandAuditStore | SqlClient.SqlClient>;
}

export class CommandExecutor extends Context.Tag("CommandExecutor")<CommandExecutor, CommandExecutorService>() {}

// Port of CommandExecutorImpl's per-decision-variant append dispatch.
const appendDecision = (
  eventStore: EventStoreService,
  decision: CD.CommandDecision
): Effect.Effect<string | null, ConcurrencyException | SqlError> => {
  switch (decision._tag) {
    case "Commutative":
      return decision.idempotencyKey !== null
        ? eventStore.appendIdempotent(
            decision.events,
            decision.idempotencyKey.eventType,
            decision.idempotencyKey.tagKey,
            decision.idempotencyKey.tagValue
          )
        : eventStore.appendCommutative(decision.events);

    case "CommutativeGuarded": {
      // Fold the lifecycle guard and any idempotency key into one AppendCondition, so the guard
      // check and the append become a single atomic call (advisory-lock protected inside
      // append_events_if()) instead of a separate existence check + blind append with a race
      // window between them. Idempotency is checked before concurrency (matching
      // append_events_if()'s own precedence), so an idempotent retry against a since-changed
      // lifecycle state returns the duplicate result instead of a spurious guard violation.
      const idempotencyQuery = decision.idempotencyKey
        ? Query.forEventAndTag(
            decision.idempotencyKey.eventType,
            decision.idempotencyKey.tagKey,
            decision.idempotencyKey.tagValue
          )
        : Query.noCondition();
      const condition = AppendCondition.of(decision.guardPosition, decision.guardQuery, idempotencyQuery);

      // PATTERN PRIMER - `Effect.catchTag("SomeTag", handler)`: the typed-error equivalent of
      // `catch (e) { if (e instanceof SomeError) { ... } else { throw e; } }`, but checked at
      // compile time instead of with a runtime `instanceof`. It only intercepts failures whose
      // `_tag` matches the given literal (see CommandDecision.ts's primer on `_tag` discriminants -
      // `Data.TaggedError` classes like `ConcurrencyException` get this field automatically); any
      // other failure in the `E` union passes straight through untouched. `handler` can either
      // recover (return `Effect.succeed(...)`, turning a failure into a success) or re-fail with a
      // different error (`Effect.fail(...)`, as both branches below do) - either way, TypeScript
      // recomputes the resulting `Effect`'s error type accordingly, so callers still see an
      // accurate `E`.
      return eventStore.appendConditional(decision.events, condition).pipe(
        Effect.catchTag("ConcurrencyException", (guardEx) => {
          // Relabel a genuine guard (lifecycle) conflict as GUARD_VIOLATION, preserving the
          // external error-code contract. An idempotency duplicate is rethrown unchanged so the
          // caller's duplicatePolicyFor-equivalent dispatch still applies.
          const v = guardEx.violation;
          if (v !== null && v.errorCode === "DCB_VIOLATION") {
            const relabeled: DCBViolation = {
              errorCode: "GUARD_VIOLATION",
              message: "Concurrent lifecycle event detected",
              matchingEventsCount: v.matchingEventsCount
            };
            return Effect.fail(
              new ConcurrencyException({
                message: "Commutative guard violated: lifecycle state changed since projection",
                violation: relabeled
              })
            );
          }
          return Effect.fail(guardEx);
        })
      );
    }

    case "NonCommutative":
      return eventStore.appendNonCommutative(decision.events, decision.decisionModel, decision.streamPosition);

    case "Idempotent":
      return eventStore.appendIdempotent(decision.events, decision.eventType, decision.tagKey, decision.tagValue);

    case "NoOp":
      return Effect.succeed(null);
  }
};

// Port of CommandExecutorImpl.duplicatePolicyFor.
const duplicatePolicyFor = (decision: CD.CommandDecision): CD.OnDuplicate => {
  switch (decision._tag) {
    case "Idempotent":
      return decision.onDuplicate;
    case "Commutative":
      return decision.idempotencyKey?.onDuplicate ?? "RETURN_IDEMPOTENT";
    case "CommutativeGuarded":
      return decision.idempotencyKey?.onDuplicate ?? "RETURN_IDEMPOTENT";
    default:
      return "RETURN_IDEMPOTENT";
  }
};

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
      E | ConcurrencyException | SqlError,
      EventStore | CommandAuditStore | SqlClient.SqlClient
    > =>
      // sql.withTransaction(effect) runs `effect` inside one Postgres transaction, committing on
      // success and rolling back on any failure (including interruption). Because @effect/sql
      // makes the "current" SqlClient ambient (see EventStore.ts's Effect.gen/yield* primer), the
      // `EventStore`/`CommandAuditStore` obtained via `yield*` *inside* this block automatically
      // use the transaction-scoped connection - no separate "transaction-scoped" implementation
      // class is needed (unlike Java's EventStoreImpl, which needs a whole second
      // ConnectionScopedEventStore inner class for exactly this reason - see NOTES.md's Phase 1
      // write-up for the full comparison).
      //
      // `commandType` exists purely to tag CommandMetrics (see the interface's doc comment above) -
      // wrapped with CommandMetrics.observe for the handle.duration/successes/failures triplet, plus
      // a dedicated idempotentDuplicates increment when the result comes back idempotent.
      CommandMetrics.observe(
        CommandMetrics.handle,
        sql.withTransaction(
          Effect.gen(function* () {
            const eventStore = yield* EventStore;
            const decision = yield* handler(command);

            if (decision._tag === "NoOp") {
              return ExecutionResultNS.idempotent(decision.reason ?? "DUPLICATE_OPERATION");
            }

            const appendResult = yield* appendDecision(eventStore, decision).pipe(
              Effect.catchTag("ConcurrencyException", (e) => {
                const message = e.message ?? "";
                const isDuplicate = message.toLowerCase().includes("duplicate operation detected");
                if (!isDuplicate) return Effect.fail(e);
                if (duplicatePolicyFor(decision) === "THROW") return Effect.fail(e);
                return Effect.succeed("idempotent" as const);
              })
            );

            if (appendResult === "idempotent") {
              return ExecutionResultNS.idempotent("DUPLICATE_OPERATION");
            }
            return ExecutionResultNS.created();
          })
        ).pipe(
          Effect.tap((result) => {
            if (!result.wasIdempotent) return Effect.void;
            const taggedCounter: Metric.Metric.Counter<number> = Metric.tagged(
              CommandMetrics.idempotentDuplicates,
              "command_type",
              commandType
            );
            return Metric.increment(taggedCounter);
          })
        ),
        [["command_type", commandType]]
      );

    const service: CommandExecutorService = { execute };
    return service;
  })
);
