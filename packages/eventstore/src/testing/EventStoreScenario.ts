import { Cause, Clock, DateTime, Effect, Exit } from "effect";
import type { EventStore, StoredEvent } from "../EventStore.ts";
import type { AppendEvent } from "../AppendEvent.ts";
import { makeInMemoryEventStore, type InMemoryEventStore } from "./InMemoryEventStore.ts";

// Given/When/Then for code that uses the event store directly (ADR-0050), with NO database: given the log, when the code runs, then what it answered
// and what it appended.
//
//     const result = await givenEvents(CopyLent(...)).when(lendCopy("c-1", "m-7"));
//
//     expect(result.outcome).toBe("failed");
//     if (result.outcome === "failed") expect(result.error).toBeInstanceOf(CopyNotAvailable);
//     expect(result.events).toEqual([]);
//
// The code runs as it is, against the in-memory store (which passes the store's conformance suite): `when` adds no transaction of its own, so code
// that appends and then fails outside a `transaction` leaves its appends in the log, as it would on Postgres, and `events` shows them. Later `when`s
// see earlier ones' effects. A defect (a bug, not a failure the code declares) fails the test loudly instead of becoming a result.
//
// What it cannot show: concurrency (nothing interleaves, so a `Conflict` only comes from an append made between a read and the code's own append)
// and what is Postgres's own (transaction visibility, LISTEN). For code that goes through commands, `given` in `@crablet/commands/testing/Scenario`.

// What one `when` gave: the code's value or its typed failure, and exactly the events it appended (an all-or-nothing `transaction` that failed
// appended none).
export type EventStoreResult<A, E> =
  | { readonly outcome: "succeeded"; readonly value: A; readonly events: ReadonlyArray<StoredEvent> }
  | { readonly outcome: "failed"; readonly error: E; readonly events: ReadonlyArray<StoredEvent> };

export interface EventStoreScenario {
  readonly store: InMemoryEventStore;
  // The whole log so far: the given events, then what every `when` appended.
  readonly log: ReadonlyArray<StoredEvent>;
  readonly when: <A, E>(effect: Effect.Effect<A, E, EventStore>) => Promise<EventStoreResult<A, E>>;
  // The same scenario (same log) with the clock fixed at `now`: the `occurredAt` of what the code appends, and what it reads from `Clock`.
  readonly at: (now: DateTime.Utc) => EventStoreScenario;
}

// A clock that reads `ms` as the time and is otherwise the real one (sleeping, scheduling). Also what `@crablet/commands/testing/Scenario`'s `at` uses.
export const fixedClock = (base: Clock.Clock, ms: number): Clock.Clock =>
  Object.assign(Object.create(base), {
    currentTimeMillisUnsafe: () => ms,
    currentTimeMillis: Effect.succeed(ms),
    currentTimeNanosUnsafe: () => BigInt(ms) * 1_000_000n,
    currentTimeNanos: Effect.succeed(BigInt(ms) * 1_000_000n)
  });

const over = (store: InMemoryEventStore, atMs: number | null): EventStoreScenario => ({
  store,
  get log() {
    return store.log;
  },
  when: async <A, E>(effect: Effect.Effect<A, E, EventStore>): Promise<EventStoreResult<A, E>> => {
    const before = store.log.length;
    const provided = Effect.provide(effect, store.layer);
    const program = atMs === null ? provided : Effect.flatMap(Clock.Clock, (base) => Effect.provideService(provided, Clock.Clock, fixedClock(base, atMs)));
    const exit = await Effect.runPromiseExit(program);
    const events = store.log.slice(before);
    if (Exit.isSuccess(exit)) return { outcome: "succeeded", value: exit.value, events };
    const failure = exit.cause.reasons.find(Cause.isFailReason);
    if (failure === undefined) throw new Error(`the code under test died: ${Cause.pretty(exit.cause)}`);
    return { outcome: "failed", error: failure.error, events };
  },
  at: (now) => over(store, DateTime.toEpochMillis(now))
});

// The log the code starts from. The events are stored as they are (no condition), as test setup.
export const givenEvents = (...events: ReadonlyArray<AppendEvent>): EventStoreScenario => {
  const store = makeInMemoryEventStore();
  store.seed(...events);
  return over(store, null);
};
