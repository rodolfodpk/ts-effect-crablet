// Test helper: waits until `parties` callers have arrived, then releases them all together, so that several
// commands have all LOADED before any of them appends (a deterministic race instead of timing luck).
import { Deferred, Effect, Ref } from "effect";

export const barrier = (parties: number) =>
  Effect.gen(function* () {
    const arrived = yield* Ref.make(0);
    const gate = yield* Deferred.make<void>();
    return Effect.gen(function* () {
      if ((yield* Ref.updateAndGet(arrived, (n) => n + 1)) >= parties) yield* Deferred.succeed(gate, undefined);
      yield* Deferred.await(gate);
    });
  });
