import { Context, Duration, Effect, Layer, Metric, Option, Ref } from "effect";
import { SqlClient } from "effect/sql";
import type { SqlError } from "effect/sql/SqlError";
import * as SnapshotMetrics from "@crablet/metrics-otel/SnapshotMetrics";
import type { LogPosition } from "./LogPosition.ts";
import type { Query } from "./Query.ts";

// Model snapshots (ADR-0018): a cache of a model's folded state at a settled cursor, in `crablet_model_snapshots` (migration V9). Derived data: losing a row
// loses nothing, a load that finds none folds the whole boundary.
//
// A snapshot is identified by (name, version, the boundary query). The query is passed here as its CANONICAL text (`canonicalQuery`), and the database hashes it
// (`sha256`), so the key is computed in one place for reads and writes and nothing in TypeScript needs a hash function (this module stays free of Node built-ins).

export interface SnapshotKey {
  readonly name: string;
  readonly version: number;
  // `canonicalQuery(model.query)`
  readonly canonical: string;
}

export interface StoredSnapshot {
  // JSON, as stored; the model decodes it with its state schema and ignores the snapshot if that fails
  readonly state: unknown;
  // the settled cursor the state was folded to: (transaction_id, position)
  readonly cursor: LogPosition;
}

export interface PendingSnapshot extends SnapshotKey {
  readonly cursor: LogPosition;
  readonly state: unknown;
}

export interface SnapshotStoreService {
  readonly get: (key: SnapshotKey) => Effect.Effect<StoredSnapshot | null, SqlError>;
  // Forward-only (`crablet_save_snapshot`): true when the row was written, false when an equal or later cursor is already stored.
  readonly save: (snapshot: PendingSnapshot) => Effect.Effect<boolean, SqlError>;
  // Maintenance: delete the snapshots of `name` that are not of `keepVersion`; returns how many.
  readonly pruneOtherVersions: (name: string, keepVersion: number) => Effect.Effect<number, SqlError>;
}

export class SnapshotStore extends Context.Service<SnapshotStore, SnapshotStoreService>()("SnapshotStore") {}

// The text a boundary query is keyed by: the same set of items, event types and tags gives the same text whatever the order they were written in.
// A type and a tag cannot collide: they are different JSON fields.
export const canonicalQuery = (query: Query): string =>
  JSON.stringify(
    query.items
      .map((item) => ({ types: [...item.eventTypes].sort(), tags: item.tags.map((t) => [t.key, t.value] as const).sort((a, b) => (a[0] === b[0] ? (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0) : a[0] < b[0] ? -1 : 1)) }))
      .map((item) => JSON.stringify(item))
      .sort()
  );

const FINGERPRINT = "encode(sha256(convert_to($3, 'UTF8')), 'hex')";

export const SnapshotStoreLive = Layer.effect(
  SnapshotStore,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const service: SnapshotStoreService = {
      get: (key) =>
        Effect.map(
          sql.unsafe<{ transaction_id: string; position: string; state: unknown }>(
            `SELECT transaction_id::text AS transaction_id, position::text AS position, state FROM crablet_model_snapshots
             WHERE name = $1 AND version = $2 AND fingerprint = ${FINGERPRINT}`,
            [key.name, key.version, key.canonical]
          ),
          (rows) => (rows[0] ? { state: rows[0].state, cursor: { position: BigInt(rows[0].position), occurredAt: null, transactionId: rows[0].transaction_id } } : null)
        ),
      save: (s) =>
        Effect.map(
          sql.unsafe<{ written: boolean }>(
            `SELECT crablet_save_snapshot($1, $2, ${FINGERPRINT}, $4::xid8, $5::bigint, $6::jsonb) AS written`,
            [s.name, s.version, s.canonical, s.cursor.transactionId, s.cursor.position.toString(), JSON.stringify(s.state)]
          ),
          (rows) => rows[0]!.written
        ),
      pruneOtherVersions: (name, keepVersion) =>
        Effect.map(
          sql.unsafe<{ version: number }>("DELETE FROM crablet_model_snapshots WHERE name = $1 AND version <> $2 RETURNING version", [name, keepVersion]),
          (rows) => rows.length
        )
    };
    return service;
  })
);

// Where a load leaves the snapshot it would like written. The load runs INSIDE the command's transaction, and a write from there would need a second
// connection while holding the first, which deadlocks a small pool (measured: packages/commands/diagnostics/snapshot-write-spike.diagnostic.ts). So the load
// only RECORDS it here and the executor writes it after the transaction ended (`flushSnapshots`). Absent from the context = nothing is recorded.
export interface SnapshotCollectorService {
  // One pending write per key: the later cursor, in (transaction_id, position) order, wins.
  readonly add: (pending: PendingSnapshot) => Effect.Effect<void>;
  readonly drain: Effect.Effect<ReadonlyArray<PendingSnapshot>>;
}

export class SnapshotCollector extends Context.Service<SnapshotCollector, SnapshotCollectorService>()("SnapshotCollector") {}

const keyOf = (p: SnapshotKey): string => `${p.name}\u0000${p.version}\u0000${p.canonical}`;
const isLater = (a: LogPosition, b: LogPosition): boolean =>
  a.transactionId !== null && b.transactionId !== null && BigInt(a.transactionId) !== BigInt(b.transactionId)
    ? BigInt(a.transactionId) > BigInt(b.transactionId)
    : a.position > b.position;

export const makeSnapshotCollector: Effect.Effect<SnapshotCollectorService> = Effect.map(
  Ref.make<ReadonlyMap<string, PendingSnapshot>>(new Map()),
  (ref) => ({
    add: (pending) =>
      Ref.update(ref, (m) => {
        const existing = m.get(keyOf(pending));
        return existing && !isLater(pending.cursor, existing.cursor) ? m : new Map(m).set(keyOf(pending), pending);
      }),
    drain: Ref.getAndSet(ref, new Map()).pipe(Effect.map((m) => [...m.values()]))
  })
);

export const SnapshotCollectorLive: Layer.Layer<SnapshotCollector> = Layer.effect(SnapshotCollector, makeSnapshotCollector);

// Writes the given pending snapshots, one at a time, each with a timeout, and ignores every failure (a warning and a `failed` count): a snapshot is a cache,
// and not writing one costs only the next load a longer tail.
export const writeSnapshots = (store: SnapshotStoreService, pendings: ReadonlyArray<PendingSnapshot>): Effect.Effect<void> => {
  const count = (name: string, outcome: string) => Metric.update(Metric.withAttributes(SnapshotMetrics.writes, { model: name, outcome }), 1);
  return Effect.forEach(
    pendings,
    (p) =>
      store.save(p).pipe(
        Effect.timeout(Duration.seconds(1)),
        Effect.flatMap((written) => count(p.name, written ? "written" : "not_newer")),
        Effect.catchCause((cause) => Effect.andThen(Effect.logWarning(`snapshot ${p.name} v${p.version} not written: ${String(cause)}`), count(p.name, "failed")))
      ),
    { discard: true }
  );
};

// Writes what the collector holds. Call it AFTER the command's transaction has ended, whether it committed or not (the state is the state at a settled
// cursor, valid either way).
export const flushSnapshots: Effect.Effect<void, never, SnapshotCollector | SnapshotStore> = Effect.gen(function* () {
  const collector = yield* SnapshotCollector;
  const store = yield* SnapshotStore;
  yield* writeSnapshots(store, yield* collector.drain);
});

// The executor's flush: the same, for a collector it made itself, and a no-op when nothing was recorded (every command on a model without a snapshot) or
// when the context has no store.
export const flushCollected = (collector: SnapshotCollectorService): Effect.Effect<void> =>
  Effect.gen(function* () {
    const pendings = yield* collector.drain;
    if (pendings.length === 0) return;
    const store = yield* Effect.serviceOption(SnapshotStore);
    if (Option.isSome(store)) yield* writeSnapshots(store.value, pendings);
  });
