import { Effect } from "effect";
import type { EventStoreService, StoredEvent } from "../EventStore.ts";
import { existsProjector } from "../EventStore.ts";
import type { AppendEvent } from "../AppendEvent.ts";
import type { AppendCondition } from "../AppendCondition.ts";
import type { Query, QueryItem } from "../Query.ts";
import * as LogPositionNS from "../LogPosition.ts";

// A minimal in-memory EventStoreService for UNIT tests of code that reads events (models, folds,
// command handlers that only `load` and `decide`). It matches queries exactly like the SQL read path
// - an item matches an event when (types empty OR event type is one of them) AND (event carries all
// the item's tags); a query matches when any non-empty item matches, and a query with no non-empty
// item matches everything - and it records every `append` call.
//
// It deliberately does NOT enforce append conditions: it never reports `Conflict` or `Duplicate`.
// Anything that depends on concurrency or idempotency must be tested against real Postgres (or the
// in-memory store with enforcement planned for a later phase).

const itemMatches = (item: QueryItem, event: StoredEvent): boolean =>
  (item.eventTypes.length === 0 || item.eventTypes.includes(event.type)) &&
  item.tags.every((t) => event.tags.some((x) => x.key === t.key && x.value === t.value));

export const queryMatches = (query: Query, event: StoredEvent): boolean => {
  const items = query.items.filter((i) => i.eventTypes.length > 0 || i.tags.length > 0);
  return items.length === 0 || items.some((i) => itemMatches(i, event));
};

export interface FakeEventStore {
  readonly service: EventStoreService;
  // Every stored event, in position order.
  readonly log: ReadonlyArray<StoredEvent>;
  // Every `append` call, in order, with the condition it was given (if any).
  readonly appended: ReadonlyArray<{ readonly events: ReadonlyArray<AppendEvent>; readonly condition: AppendCondition | null }>;
  // Seed events without recording an `append` call (test setup).
  readonly seed: (...events: ReadonlyArray<AppendEvent>) => void;
}

export const makeFakeEventStore = (): FakeEventStore => {
  const log: Array<StoredEvent> = [];
  const appended: Array<{ events: ReadonlyArray<AppendEvent>; condition: AppendCondition | null }> = [];
  let next = 1n;

  const store = (events: ReadonlyArray<AppendEvent>) => {
    for (const e of events) {
      log.push({
        type: e.type,
        tags: e.tags,
        // round-trip through JSON like the real store, so data is plain JSON
        data: JSON.parse(JSON.stringify(e.eventData)),
        transactionId: "1",
        position: next++,
        occurredAt: new Date(),
        correlationId: null,
        causationId: null
      });
    }
  };

  const project: EventStoreService["project"] = (query, after, projectors) =>
    Effect.sync(() => {
      let state = projectors[0]!.initialState;
      let last = after;
      for (const event of log) {
        if (event.position <= after.position || !queryMatches(query, event)) continue;
        for (const projector of projectors) {
          if (projector.eventTypes.length === 0 || projector.eventTypes.includes(event.type)) {
            state = projector.transition(state, event);
          }
        }
        last = LogPositionNS.of(event.position, event.occurredAt, event.transactionId);
      }
      return { state: state as never, logPosition: last };
    });

  const append = ((events: ReadonlyArray<AppendEvent>, condition?: AppendCondition) =>
    Effect.sync(() => {
      appended.push({ events, condition: condition ?? null });
      store(events);
      return "fake-transaction";
    })) as EventStoreService["append"];

  return {
    service: {
      append,
      project,
      exists: (query) => Effect.map(project(query, LogPositionNS.zero(), [existsProjector()]), (r) => r.state)
    },
    log,
    appended,
    seed: (...events) => store(events)
  };
};
