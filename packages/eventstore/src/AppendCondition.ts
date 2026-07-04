import * as Query from "./Query.ts";
import * as StreamPosition from "./StreamPosition.ts";
import type { Query as QueryType } from "./Query.ts";
import type { StreamPosition as StreamPositionType } from "./StreamPosition.ts";

// Port of com.crablet.eventstore.AppendCondition. Supports two independent checks:
// concurrencyQuery (conflicting writes after afterPosition) and idempotencyQuery (duplicate
// operations regardless of position).
export interface AppendCondition {
  readonly afterPosition: StreamPositionType;
  readonly concurrencyQuery: QueryType;
  readonly idempotencyQuery: QueryType;
}

export const of = (
  afterPosition: StreamPositionType,
  concurrencyQuery: QueryType,
  idempotencyQuery?: QueryType
): AppendCondition => ({
  afterPosition,
  concurrencyQuery,
  idempotencyQuery: idempotencyQuery ?? Query.noCondition()
});

export const idempotent = (eventType: string, tagKey: string, tagValue: string): AppendCondition => ({
  afterPosition: StreamPosition.zero(),
  concurrencyQuery: Query.noCondition(),
  idempotencyQuery: Query.forEventAndTag(eventType, tagKey, tagValue)
});

export const idempotentFromQuery = (idempotencyQuery: QueryType): AppendCondition => ({
  afterPosition: StreamPosition.zero(),
  concurrencyQuery: Query.noCondition(),
  idempotencyQuery
});

export const empty = (): AppendCondition => ({
  afterPosition: StreamPosition.zero(),
  concurrencyQuery: Query.noCondition(),
  idempotencyQuery: Query.noCondition()
});

// UmaDB-style fluent factory: failIfChanged(decisionModel).after(streamPosition)
export const failIfChanged = (decisionModel: QueryType) => ({
  after: (streamPosition: StreamPositionType): AppendCondition => ({
    afterPosition: streamPosition,
    concurrencyQuery: decisionModel,
    idempotencyQuery: Query.noCondition()
  })
});
