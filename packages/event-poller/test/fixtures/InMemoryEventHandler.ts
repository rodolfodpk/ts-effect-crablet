import { Effect, Ref } from "effect";
import type { StoredEvent } from "@crablet/eventstore";
import type { EventHandler } from "../../src/EventHandler.ts";

export interface InMemoryEventHandlerHandle<I> {
  readonly handler: EventHandler<I, string, never>;
  readonly handledBatches: Effect.Effect<ReadonlyArray<ReadonlyArray<StoredEvent>>>;
  readonly callCount: Effect.Effect<number>;
}

// Fast, in-memory EventHandler double. `failFirstN` lets tests simulate the "handler exception ->
// recordError -> rethrow" path deterministically.
export const makeInMemoryEventHandler = <I>(options?: {
  readonly failFirstN?: number;
}): Effect.Effect<InMemoryEventHandlerHandle<I>> =>
  Effect.gen(function* () {
    const batchesRef = yield* Ref.make<ReadonlyArray<ReadonlyArray<StoredEvent>>>([]);
    const callCountRef = yield* Ref.make(0);
    const failFirstN = options?.failFirstN ?? 0;

    const handle = (_processorId: I, events: ReadonlyArray<StoredEvent>): Effect.Effect<number, string> =>
      Effect.gen(function* () {
        const callCount = yield* Ref.updateAndGet(callCountRef, (n) => n + 1);
        if (callCount <= failFirstN) {
          return yield* Effect.fail(`simulated failure #${callCount}`);
        }
        yield* Ref.update(batchesRef, (b) => [...b, events]);
        return events.length;
      });

    const handle_: InMemoryEventHandlerHandle<I> = {
      handler: { handle },
      handledBatches: Ref.get(batchesRef),
      callCount: Ref.get(callCountRef)
    };
    return handle_;
  });
