// Test helper: waits until `parties` callers have arrived, then releases them all together, so that several
// commands have all LOADED before any of them appends (a deterministic race instead of timing luck).
import { Deferred, Effect, Ref } from "effect";
import type { ModelInstance } from "../../src/Model.ts";

export const barrier = (parties: number) =>
  Effect.gen(function* () {
    const arrived = yield* Ref.make(0);
    const gate = yield* Deferred.make<void>();
    return Effect.gen(function* () {
      if ((yield* Ref.updateAndGet(arrived, (n) => n + 1)) >= parties) yield* Deferred.succeed(gate, undefined);
      yield* Deferred.await(gate);
    });
  });

// Wraps a model so that `wait` runs right AFTER the model has loaded and BEFORE the command decides and
// appends. With a `barrier(n)` as `wait`, n commands have all loaded before any of them appends - the one
// place a barrier can force a race (a barrier in `prepare` runs BEFORE the load, so a fast command could
// still load, decide and append before a slow one has even loaded).
export const afterLoad = <S>(model: ModelInstance<S>, wait: Effect.Effect<void>): ModelInstance<S> => ({
  ...model,
  load: (es) => Effect.tap(model.load(es), () => wait)
});
