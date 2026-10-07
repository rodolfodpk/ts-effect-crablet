import { Data, Effect, Metric } from "effect";
import * as EventStoreMetrics from "@crablet/metrics-otel/EventStoreMetrics";

// A stored event that its definition cannot read (ADR-0017). Two values, because two places know different things:
//
// - `EventDecodingFailure` is THROWN by an event definition's `decode` (the fold is synchronous). It knows what is wrong with the payload (`issues`) and the
//   event type, and nothing about where the event sits in the log.
// - `EventDecodingError` is the typed failure that `EventStore.project` raises from it, adding what only the read loop knows: the event's position and the id of
//   the transaction that wrote it. It is an ordinary typed error (in the `E` channel, not a defect), so a caller can tell WHICH stored event is unreadable.
//
// Never the payload: `issues` are paths and messages (the schema's default messages do not echo the value, see ADR-0017), so they can be logged for events that
// carry personal data. An event that cannot be decoded is never skipped: a decision made over a partial boundary is worse than a refused one.

export interface DecodingIssue {
  // where in the payload, e.g. ["items", 2, "amount"]
  readonly path: ReadonlyArray<string | number>;
  readonly message: string;
}

// (No constructor parameter properties here: Node's type stripping, which runs these files, does not support them.)
export class EventDecodingFailure extends Error {
  readonly _tag = "EventDecodingFailure";
  readonly eventType: string;
  readonly issues: ReadonlyArray<DecodingIssue>;
  constructor(eventType: string, issues: ReadonlyArray<DecodingIssue>) {
    super(`event "${eventType}" does not match its definition: ${describeIssues(issues)}`);
    this.name = "EventDecodingFailure";
    this.eventType = eventType;
    this.issues = issues;
  }
}

export class EventDecodingError extends Data.TaggedError("EventDecodingError")<{
  readonly message: string;
  readonly type: string;
  readonly position: bigint;
  readonly transactionId: string;
  readonly issues: ReadonlyArray<DecodingIssue>;
}> {}

export const describeIssues = (issues: ReadonlyArray<DecodingIssue>): string =>
  issues.map((i) => (i.path.length === 0 ? i.message : `${i.message} at ${i.path.join(".")}`)).join("; ");

export const decodingErrorOf = (
  failure: EventDecodingFailure,
  event: { readonly position: bigint; readonly transactionId: string }
): EventDecodingError =>
  new EventDecodingError({
    message: `stored event ${failure.eventType} at position ${event.position} (transaction ${event.transactionId}) cannot be read: ${describeIssues(failure.issues)}`,
    type: failure.eventType,
    position: event.position,
    transactionId: event.transactionId,
    issues: failure.issues
  });

// Says it once, where it was found: a log line (position, transaction, type and the issues, never the payload) and a count by event type, then fails with the
// error. `EventStore.project` and `decodeStored` (an event definition's reader for projectors and automations) both go through it.
export const reportDecodingError = (error: EventDecodingError): Effect.Effect<never, EventDecodingError> =>
  Effect.logError(error.message).pipe(
    Effect.andThen(Metric.update(Metric.withAttributes(EventStoreMetrics.decodingFailures, { event_type: error.type }), 1)),
    Effect.andThen(Effect.fail(error))
  );
