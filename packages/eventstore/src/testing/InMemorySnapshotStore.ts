import { Effect, Layer } from "effect";
import { SnapshotStore, type PendingSnapshot, type SnapshotKey, type SnapshotStoreService, type StoredSnapshot } from "../SnapshotStore.ts";

// A SnapshotStore over a Map, for unit tests: the same contract as the Postgres one (keyed by name, version and canonical query; `save` forward-only and
// saying whether it wrote), without a database. `rows` is exposed for assertions.
export interface InMemorySnapshotStore {
  readonly service: SnapshotStoreService;
  readonly layer: Layer.Layer<SnapshotStore>;
  readonly rows: ReadonlyMap<string, PendingSnapshot>;
  // how many times `get` was called, to assert a model without a snapshot never asks
  readonly gets: () => number;
}

const keyOf = (k: SnapshotKey): string => `${k.name}\u0000${k.version}\u0000${k.canonical}`;
const later = (a: PendingSnapshot["cursor"], b: PendingSnapshot["cursor"]): boolean =>
  a.transactionId !== null && b.transactionId !== null && BigInt(a.transactionId) !== BigInt(b.transactionId) ? BigInt(a.transactionId) > BigInt(b.transactionId) : a.position > b.position;

export const makeInMemorySnapshotStore = (): InMemorySnapshotStore => {
  const rows = new Map<string, PendingSnapshot>();
  let gets = 0;
  const service: SnapshotStoreService = {
    get: (key) =>
      Effect.sync((): StoredSnapshot | null => {
        gets++;
        const row = rows.get(keyOf(key));
        return row ? { state: JSON.parse(JSON.stringify(row.state)), cursor: row.cursor } : null;
      }),
    save: (snapshot) =>
      Effect.sync(() => {
        const existing = rows.get(keyOf(snapshot));
        if (existing && !later(snapshot.cursor, existing.cursor)) return false;
        rows.set(keyOf(snapshot), { ...snapshot, state: JSON.parse(JSON.stringify(snapshot.state)) });
        return true;
      }),
    list: (filter) =>
      Effect.sync(() =>
        [...rows.values()]
          .filter((r) => r.name === filter.name && (filter.version === undefined || r.version === filter.version))
          .slice(0, filter.limit)
          .map((r) => ({ name: r.name, version: r.version, fingerprint: r.canonical, entity: r.entity ?? null, state: JSON.parse(JSON.stringify(r.state)), cursor: r.cursor }))
      ),
    summary: Effect.sync(() => {
      const counts = new Map<string, { name: string; version: number; count: number }>();
      for (const r of rows.values()) {
        const k = `${r.name}\u0000${r.version}`;
        const c = counts.get(k) ?? { name: r.name, version: r.version, count: 0 };
        counts.set(k, { ...c, count: c.count + 1 });
      }
      return [...counts.values()];
    }),
    // the in-memory key is the canonical text itself
    fingerprint: (canonical) => Effect.succeed(canonical),
    pruneOtherVersions: (name, keepVersion) =>
      Effect.sync(() => {
        let removed = 0;
        for (const [k, v] of rows) if (v.name === name && v.version !== keepVersion) (rows.delete(k), removed++);
        return removed;
      })
  };
  return { service, layer: Layer.succeed(SnapshotStore, service), rows, gets: () => gets };
};
