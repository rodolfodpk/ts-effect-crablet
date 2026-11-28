import { Cause, Clock, Duration, Effect, Exit, Metric } from "effect";
import * as CommandMetrics from "@crablet/metrics-otel/CommandMetrics";
import * as CorrelationContext from "@crablet/eventstore/CorrelationContext";
import { IdempotencyMismatch, kindOf, type ErrorKind } from "./Errors.ts";
import type { ExecutionResult } from "./ExecutionResult.ts";

// What one execution of a command ended as, after its retries (ADR-0056). A bounded set: `error` is a declared error's tag or one of the
// framework's few (`SqlError`, `AppendTooLarge`, `EventDecodingError`, `defect`, `interrupted`), never a message.
export type Outcome =
  | { readonly outcome: "created" }
  | { readonly outcome: "idempotent" }
  | { readonly outcome: "rejected"; readonly error: string; readonly kind: ErrorKind }
  | { readonly outcome: "mismatch" }
  | { readonly outcome: "conflict" }
  | { readonly outcome: "error"; readonly error: string };

const tagOf = (error: unknown): string =>
  typeof error === "object" && error !== null && "_tag" in error && typeof error._tag === "string" ? error._tag : "unknown";

export const outcomeOf = <E>(exit: Exit.Exit<ExecutionResult, E>): Outcome => {
  if (Exit.isSuccess(exit)) return { outcome: exit.value.wasIdempotent ? "idempotent" : "created" };
  const failure = exit.cause.reasons.find(Cause.isFailReason);
  if (failure === undefined) return { outcome: "error", error: exit.cause.reasons.some(Cause.isDieReason) ? "defect" : "interrupted" };
  const error: unknown = failure.error;
  const kind = kindOf(error);
  if (kind !== undefined) return { outcome: "rejected", error: tagOf(error), kind };
  if (error instanceof IdempotencyMismatch) return { outcome: "mismatch" };
  const tag = tagOf(error);
  return tag === "Conflict" ? { outcome: "conflict" } : { outcome: "error", error: tag };
};

// An execution whose outcome is an answer to the caller (it appended, it was a repeat, the domain said no, the key was reused) ends its span ok; a
// conflict that outlived its retries and a fault end it failed.
const isAnswer = (o: Outcome): boolean => o.outcome !== "conflict" && o.outcome !== "error";

const attributesOf = (name: string, o: Outcome): Record<string, string> => ({
  command_type: name,
  outcome: o.outcome,
  ...("error" in o ? { error: o.error } : {})
});

// One execution, reported: `attempts` runs the command (with its retries) and is told each attempt by `attempt`. Records
// `crablet.command.executions` and `crablet.command.execution.duration` by command, outcome and error, and puts the outcome on the
// `crablet.command` span, which it opens. The caller gets exactly what `attempts` gave: the span's status is changed by turning an answer into a
// value inside the span and failing with it again outside.
export const reportExecution = <E, R>(
  command: { readonly name: string; readonly retries: number },
  attempts: (attempt: <A, E1, R1>(effect: Effect.Effect<A, E1, R1>) => Effect.Effect<A, E1, R1>) => Effect.Effect<ExecutionResult, E, R>
): Effect.Effect<ExecutionResult, E, R> =>
  Effect.gen(function* () {
    let count = 0;
    const attempt = <A, E1, R1>(effect: Effect.Effect<A, E1, R1>): Effect.Effect<A, E1, R1> => Effect.suspend(() => ((count += 1), effect));
    const correlationId = yield* CorrelationContext.correlationId;
    const start = yield* Clock.currentTimeNanos;
    const exit = yield* Effect.exit(attempts(attempt));
    const end = yield* Clock.currentTimeNanos;
    const outcome = outcomeOf(exit);
    const attributes = attributesOf(command.name, outcome);
    yield* Metric.update(Metric.withAttributes(CommandMetrics.executions, attributes), 1);
    yield* Metric.update(Metric.withAttributes(CommandMetrics.executionDuration, attributes), Duration.nanos(end - start));
    yield* Effect.annotateCurrentSpan({
      "crablet.command.outcome": outcome.outcome,
      "crablet.command.attempts": count,
      ...("error" in outcome ? { "crablet.command.error": outcome.error } : {}),
      ...("kind" in outcome ? { "crablet.command.error_kind": outcome.kind } : {}),
      ...(correlationId === null ? {} : { "crablet.correlation_id": correlationId })
    });
    if (isAnswer(outcome) || Exit.isSuccess(exit)) return exit;
    return yield* Effect.failCause(exit.cause);
  }).pipe(
    // One span for the whole execution, retries included: the attempts and the appends inside it are its children.
    Effect.withSpan("crablet.command", { attributes: { "crablet.command.name": command.name, "crablet.command.max_retries": command.retries } }),
    Effect.flatten
  );
