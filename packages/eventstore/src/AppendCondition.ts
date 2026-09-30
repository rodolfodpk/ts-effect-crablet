import * as Query from "./Query.ts";
import * as LogPosition from "./LogPosition.ts";
import type { Query as QueryType } from "./Query.ts";
import type { LogPosition as LogPositionType } from "./LogPosition.ts";

// Supports two independent checks:
// concurrencyQuery (conflicting writes after afterPosition) and idempotencyQuery (duplicate
// operations regardless of position).
export interface AppendCondition {
  readonly afterPosition: LogPositionType;
  readonly concurrencyQuery: QueryType;
  readonly idempotencyQuery: QueryType;
}

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
