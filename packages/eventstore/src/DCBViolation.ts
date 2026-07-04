import { Data } from "effect";

// Port of com.crablet.eventstore.DCBViolation - structured error detail from append_events_if().
export interface DCBViolation {
  readonly errorCode: string;
  readonly message: string;
  readonly matchingEventsCount: number;
}

// Port of com.crablet.eventstore.ConcurrencyException. A YieldableError (usable directly as an
// Effect failure via `yield* new ConcurrencyException(...)`), carrying the structured DCBViolation
// the same way Java's ConcurrencyException.violation field does.
export class ConcurrencyException extends Data.TaggedError("ConcurrencyException")<{
  readonly message: string;
  readonly violation: DCBViolation | null;
}> {}
