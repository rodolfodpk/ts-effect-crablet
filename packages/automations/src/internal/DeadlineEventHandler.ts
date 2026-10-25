import { Effect, Metric } from "effect";
import type { StoredEvent } from "@crablet/eventstore";
import { HandledPrefix, type EventHandler } from "@crablet/event-poller/EventHandler";
import type { Command } from "@crablet/commands/Command";
import { DeadlineScheduled, outcomeOfFailure, outcomeOfResult, type DeadlineOutcome } from "@crablet/commands/Deadline";
import type { ExecutionResult } from "@crablet/commands/ExecutionResult";
import * as DeadlineMetrics from "@crablet/metrics-otel/DeadlineMetrics";
import { withEventContext, type ExecuteDecision } from "./AutomationEventHandler.ts";

// Records that a deadline fired, in one transaction with its row's removal; returns whether it did (false: another processor fired it first).
export type RecordFiring = (
  deadline: StoredEvent,
  outcome: { readonly outcome: DeadlineOutcome; readonly reason: string | null }
) => Effect.Effect<boolean, unknown>;

// Fires a batch of due deadlines, one at a time, in due order (ADR-0043, decision 6). For each: its command runs with its input, under the deadline as
// its cause (a fresh transaction, the command's `idempotentBy` and the backstop of ADR-0035), and then its firing is recorded. A domain error is the
// command's answer (`failed`); a fault (the database, a conflict out of retries, a command not given here, an input that no longer decodes) stops the
// batch as a `HandledPrefix`: the deadlines before it stay fired, and the engine retries from this one, marking the processor FAILED after `maxErrors`.
export const makeDeadlineEventHandler = (
  commands: ReadonlyMap<string, Command<any, any>>,
  executeDecision: ExecuteDecision,
  recordFiring: RecordFiring
): EventHandler<string, unknown, never> => {
  const fireOne = (deadline: StoredEvent): Effect.Effect<void, unknown> =>
    Effect.gen(function* () {
      const scheduled = yield* DeadlineScheduled.decodeStored(deadline);
      const command = commands.get(scheduled.command);
      if (command === undefined) {
        return yield* Effect.fail(
          new Error(`deadline at position ${deadline.position}: command "${scheduled.command}" is not one the deadlines processor was given`)
        );
      }
      const input = yield* command.decodeInput(scheduled.input);
      const outcome = yield* withEventContext(deadline, executeDecision(command, input)).pipe(
        // The executor's result, typed `unknown` by ExecuteDecision (an automation ignores it).
        Effect.map((result) => outcomeOfResult(result as ExecutionResult)),
        Effect.catch((error) => {
          const failed = outcomeOfFailure(error);
          return failed === undefined ? Effect.fail(error) : Effect.succeed(failed);
        })
      );
      if (yield* recordFiring(deadline, outcome)) {
        yield* Metric.update(Metric.withAttributes(DeadlineMetrics.fired, { outcome: outcome.outcome }), 1);
      }
    });

  const handle = (_processorId: string, deadlines: ReadonlyArray<StoredEvent>): Effect.Effect<number, HandledPrefix> =>
    Effect.gen(function* () {
      for (let handled = 0; handled < deadlines.length; handled++) {
        yield* Effect.mapError(fireOne(deadlines[handled]!), (cause) => new HandledPrefix({ handled, cause }));
      }
      return deadlines.length;
    });

  return { handle };
};
