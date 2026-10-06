import { describe, expect, test } from "bun:test";
import { Duration, Effect, Layer, Ref } from "effect";
import { SqlError } from "effect/sql/SqlError";
import * as Query from "../src/Query.ts";
import {
  SnapshotCollector,
  SnapshotCollectorLive,
  SnapshotStore,
  canonicalQuery,
  flushSnapshots,
  type PendingSnapshot,
  type SnapshotStoreService
} from "../src/SnapshotStore.ts";

const cursor = (xid: string, position: bigint) => ({ position, occurredAt: null, transactionId: xid });
const pending = (name: string, canonical: string, xid: string, position: bigint, state: unknown = {}): PendingSnapshot => ({ name, version: 1, canonical, cursor: cursor(xid, position), state });

describe("canonicalQuery", () => {
  test("does not depend on the order of items, event types or tags", () => {
    const a = Query.of([Query.queryItemOf(["B", "A"], [{ key: "y", value: "2" }, { key: "x", value: "1" }]), Query.queryItemOfTag({ key: "z", value: "3" })]);
    const b = Query.of([Query.queryItemOfTag({ key: "z", value: "3" }), Query.queryItemOf(["A", "B"], [{ key: "x", value: "1" }, { key: "y", value: "2" }])]);
    expect(canonicalQuery(a)).toBe(canonicalQuery(b));
  });
  test("a different entity, type or tag value is a different query", () => {
    const base = Query.of(Query.queryItemOf(["A"], [{ key: "id", value: "1" }]));
    expect(canonicalQuery(base)).not.toBe(canonicalQuery(Query.of(Query.queryItemOf(["A"], [{ key: "id", value: "2" }]))));
    expect(canonicalQuery(base)).not.toBe(canonicalQuery(Query.of(Query.queryItemOf(["A", "B"], [{ key: "id", value: "1" }]))));
    expect(canonicalQuery(base)).not.toBe(canonicalQuery(Query.of(Query.queryItemOf(["A"], [{ key: "id2", value: "1" }]))));
  });
  test("a type and a tag cannot be confused with each other", () => {
    expect(canonicalQuery(Query.of(Query.queryItemOf(["a=b"], [])))).not.toBe(canonicalQuery(Query.of(Query.queryItemOf([], [{ key: "a", value: "b" }]))));
  });
});

const fakeStore = (saved: Array<PendingSnapshot>, behaviour: (p: PendingSnapshot) => Effect.Effect<boolean, SqlError> = () => Effect.succeed(true)): Layer.Layer<SnapshotStore> =>
  Layer.succeed(SnapshotStore, {
    get: () => Effect.succeed(null),
    save: (p) => Effect.tap(behaviour(p), () => Effect.sync(() => void saved.push(p))),
    pruneOtherVersions: () => Effect.succeed(0)
  } satisfies SnapshotStoreService);

describe("the snapshot collector and its flush", () => {
  const withCollector = <A, E>(f: Effect.Effect<A, E, SnapshotCollector | SnapshotStore>, store: Layer.Layer<SnapshotStore>) =>
    Effect.runPromise(Effect.provide(f, Layer.merge(SnapshotCollectorLive, store)) as Effect.Effect<A, E, never>);

  test("keeps one pending write per key: the later cursor wins, whatever the order", async () => {
    const saved: Array<PendingSnapshot> = [];
    await withCollector(
      Effect.gen(function* () {
        const c = yield* SnapshotCollector;
        yield* c.add(pending("m", "q1", "20", 5n, { v: "late" }));
        yield* c.add(pending("m", "q1", "10", 9n, { v: "early, higher position" }));
        yield* c.add(pending("m", "q2", "10", 1n));
        yield* flushSnapshots;
      }),
      fakeStore(saved)
    );
    expect(saved.map((s) => [s.canonical, s.cursor.transactionId, s.state])).toEqual([["q1", "20", { v: "late" }], ["q2", "10", {}]]);
  });

  test("a flush empties the collector", async () => {
    const saved: Array<PendingSnapshot> = [];
    await withCollector(
      Effect.gen(function* () {
        const c = yield* SnapshotCollector;
        yield* c.add(pending("m", "q", "1", 1n));
        yield* flushSnapshots;
        yield* flushSnapshots;
      }),
      fakeStore(saved)
    );
    expect(saved.length).toBe(1);
  });

  test("a failing or hanging save is ignored: the flush completes, and the others are still written", async () => {
    const saved: Array<PendingSnapshot> = [];
    const flaky = (p: PendingSnapshot): Effect.Effect<boolean, SqlError> =>
      p.canonical === "boom"
        ? Effect.fail(new SqlError({ reason: { _tag: "UnknownError", cause: new Error("db down"), message: "db down", operation: "x" } as never }))
        : p.canonical === "hang"
          ? Effect.never
          : Effect.succeed(true);
    await withCollector(
      Effect.gen(function* () {
        const c = yield* SnapshotCollector;
        yield* c.add(pending("m", "boom", "1", 1n));
        yield* c.add(pending("m", "hang", "1", 1n));
        yield* c.add(pending("m", "fine", "1", 1n));
        yield* flushSnapshots.pipe(Effect.timeout(Duration.seconds(5)));
      }),
      fakeStore(saved, flaky)
    );
    expect(saved.map((s) => s.canonical)).toEqual(["fine"]);
  });
});
