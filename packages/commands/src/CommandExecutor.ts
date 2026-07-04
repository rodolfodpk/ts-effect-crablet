import { Context, Effect, Layer } from "effect";
import { SqlClient } from "@effect/sql";
import type { SqlError } from "@effect/sql/SqlError";
import { EventStore, type EventStoreService } from "@crablet/eventstore";
import { CommandAuditStore } from "@crablet/eventstore/CommandAuditStore";
import { ConcurrencyException, type DCBViolation } from "@crablet/eventstore/DCBViolation";
import * as Query from "@crablet/eventstore/Query";
import * as AppendCondition from "@crablet/eventstore/AppendCondition";
import * as CD from "./CommandDecision.ts";
import * as ExecutionResultNS from "./ExecutionResult.ts";
import type { ExecutionResult } from "./ExecutionResult.ts";

// Port of com.crablet.command.CommandHandler<T> - eventStore is ambient (via Effect's context),
// not an explicit parameter, so a handler is just "given a command, produce a decision."
export type CommandHandler<T, E = never> = (command: T) => Effect.Effect<CD.CommandDecision, E, EventStore>;

export interface CommandExecutorService {
  readonly execute: <T, E>(
    command: T,
    handler: CommandHandler<T, E>
  ) => Effect.Effect<ExecutionResult, E | ConcurrencyException | SqlError, EventStore | CommandAuditStore | SqlClient.SqlClient>;
}

export class CommandExecutor extends Context.Tag("CommandExecutor")<CommandExecutor, CommandExecutorService>() {}

// Port of CommandExecutorImpl's per-decision-variant append dispatch. Command-type-string
// auto-discovery (Java's JSON `commandType` field lookup) and the command-level audit pre-check
// (COMMAND_ID-based idempotency) are deliberately out of scope for this port - callers always
// pass the handler explicitly (TS has no runtime-reflection equivalent to look one up by type),
// and command persistence-for-audit is a separate deferred concern (see NOTES.md).
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
      command: T,
      handler: CommandHandler<T, E>
    ): Effect.Effect<
      ExecutionResult,
      E | ConcurrencyException | SqlError,
      EventStore | CommandAuditStore | SqlClient.SqlClient
    > =>
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
      );

    const service: CommandExecutorService = { execute };
    return service;
  })
);
