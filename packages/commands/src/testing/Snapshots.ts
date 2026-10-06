import { Effect, Layer } from "effect";
import type { AppendEvent } from "@crablet/eventstore/AppendEvent";
import { makeInMemoryEventStore } from "@crablet/eventstore/testing/InMemoryEventStore";
import { makeInMemorySnapshotStore } from "@crablet/eventstore/testing/InMemorySnapshotStore";
import { SnapshotCollectorLive, flushSnapshots } from "@crablet/eventstore/SnapshotStore";
import type { ModelInstance } from "../Model.ts";

// The differential check of ADR-0018 for a model that declares a snapshot: loading with a snapshot (the stored state plus the events after its cursor) must give
// exactly what folding the whole boundary gives, for ANY history and ANY point at which a snapshot was taken. It is what finds a forgotten `version` bump or a
// fold that is not a pure function of its events.
//
//   checkSnapshotEquivalence({
//     snapshotted: (id) => AccountModel.of({ id }),          // built from a model with `.snapshot({ ..., every: 1 })`: write on every load
//     reference: (id) => AccountModelWithoutSnapshot.of({ id }),   // the same fold, no `.snapshot(...)`
//     id: "a1",
//     history: (random) => [...events for that id...],      // a random but VALID history; `random()` is in [0, 1)
//     runs: 200
//   })
//
// Each run: a random history is split at random points into chunks; after each chunk is appended, the snapshotted model loads (and its pending snapshot is
// written, as the executor does after the transaction), and its state is compared with the reference's, which never reads a snapshot. Fails with the seed of
// the run and the first difference. Deterministic for a given `seed`.
export interface SnapshotEquivalence<S> {
  readonly snapshotted: (id: string) => ModelInstance<S>;
  readonly reference: (id: string) => ModelInstance<S>;
  readonly id: string;
  readonly history: (random: () => number) => ReadonlyArray<AppendEvent>;
  readonly runs?: number;
  readonly seed?: number;
}

const mulberry32 = (seed: number) => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

export const checkSnapshotEquivalence = <S>(options: SnapshotEquivalence<S>): Promise<void> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const runs = options.runs ?? 100;
      const baseSeed = options.seed ?? 1;
      for (let run = 0; run < runs; run++) {
        const seed = baseSeed + run;
        const random = mulberry32(seed);
        const events = options.history(random);
        const fake = makeInMemoryEventStore();
        const snapshots = makeInMemorySnapshotStore();
        const layer = Layer.merge(snapshots.layer, SnapshotCollectorLive);
        // random chunking: each position after which a load (and so a snapshot) happens
        const cuts = new Set<number>([events.length]);
        for (let i = 1; i < events.length; i++) if (random() < 0.3) cuts.add(i);
        let from = 0;
        for (const cut of [...cuts].sort((a, b) => a - b)) {
          fake.seed(...events.slice(from, cut));
          from = cut;
          const step = Effect.gen(function* () {
            const withSnapshot = yield* options.snapshotted(options.id).load(fake.service);
            yield* flushSnapshots;
            const reference = yield* options.reference(options.id).load(fake.service);
            return { withSnapshot, reference };
          });
          const { withSnapshot, reference } = yield* Effect.provide(step, layer);
          const a = JSON.stringify(withSnapshot.state), b = JSON.stringify(reference.state);
          if (a !== b || withSnapshot.logPosition.position !== reference.logPosition.position) {
            return yield* Effect.die(
              new Error(`snapshot + tail differs from the full fold (seed ${seed}, after ${cut} of ${events.length} events): with snapshot ${a} at ${withSnapshot.logPosition.position}, full fold ${b} at ${reference.logPosition.position}`)
            );
          }
        }
      }
    })
  );

