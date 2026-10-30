import * as Query from "./Query.ts";
import * as LogPosition from "./LogPosition.ts";
import type { Query as QueryType } from "./Query.ts";
import type { LogPosition as LogPositionType } from "./LogPosition.ts";
import type { ReadSnapshot } from "./ReadSnapshot.ts";

export type { ReadSnapshot } from "./ReadSnapshot.ts";

// Supports two independent checks:
// concurrencyQuery (conflicting writes after afterPosition) and idempotencyQuery (duplicate
// operations regardless of position).
export interface AppendCondition {
  readonly afterPosition: LogPositionType;
  readonly concurrencyQuery: QueryType;
  readonly idempotencyQuery: QueryType;
  // What the read the decision was made on could see (ProjectionResult.seen). With it, a matching event after the cursor is a conflict only if
  // that read could not see it: one it saw, committed but not yet settled, is not (ADR-0048). Without it, every matching event after the cursor is.
  // Commands set it; nothing else needs to.
  readonly seen?: ReadSnapshot;
  // The append must be its transaction's first write (ADR-0033): refused (CRB01, a defect) if the transaction already wrote anything, so no write of
  // its own can come before the read the decision was made on. Without it, events the same transaction appended earlier are not a conflict for it
  // (ADR-0049). Commands always run this way; for direct use, set it with `firstWrite(...)`. No effect in the in-memory store, which has no transactions.
  readonly firstWrite?: true;
}

export const firstWrite = (condition: AppendCondition): AppendCondition => ({ ...condition, firstWrite: true });

export const of = (
  afterPosition: LogPositionType,
  concurrencyQuery: QueryType,
  idempotencyQuery?: QueryType
): AppendCondition => ({
  afterPosition,
  concurrencyQuery,
  idempotencyQuery: idempotencyQuery ?? Query.noCondition()
});

export const idempotent = (eventType: string, tagKey: string, tagValue: string): AppendCondition => ({
  afterPosition: LogPosition.zero(),
  concurrencyQuery: Query.noCondition(),
  idempotencyQuery: Query.forEventAndTag(eventType, tagKey, tagValue)
});

export const idempotentFromQuery = (idempotencyQuery: QueryType): AppendCondition => ({
  afterPosition: LogPosition.zero(),
  concurrencyQuery: Query.noCondition(),
  idempotencyQuery
});

export const empty = (): AppendCondition => ({
  afterPosition: LogPosition.zero(),
  concurrencyQuery: Query.noCondition(),
  idempotencyQuery: Query.noCondition()
});

// UmaDB-style fluent factory: failIfChanged(decisionModel).after(logPosition)
//
// PATTERN NOTE: a "curried factory" - `failIfChanged(x)` doesn't return the final value, it returns
// a small plain object with one more method (`.after(y)`) that produces the real result. This gets
// the same `verb(arg1).step(arg2)` readability as AppendEvent.ts's builder class, but without any
// mutable state or a class at all - each intermediate object is just a fresh, throwaway closure
// over `decisionModel`. Reach for this shape (rather than a class) when there's exactly one or two
// staged arguments and no branching/optional calls in between; reach for a real builder class (see
// AppendEvent.ts) once there are several optional/repeatable steps.
export const failIfChanged = (decisionModel: QueryType) => ({
  after: (logPosition: LogPositionType): AppendCondition => ({
    afterPosition: logPosition,
    concurrencyQuery: decisionModel,
    idempotencyQuery: Query.noCondition()
  })
});
