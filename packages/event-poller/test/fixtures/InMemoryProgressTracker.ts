import { Effect, Ref } from "effect";
import type { ProcessorStatus } from "../../src/ProcessorStatus.ts";
import type { ProgressTracker } from "../../src/ProgressTracker.ts";

interface Row {
  readonly status: ProcessorStatus;
  readonly lastPosition: bigint;
  readonly errorCount: number;
  readonly instanceId: string | null;
}

export interface InMemoryProgressTrackerHandle<I> {
  readonly tracker: ProgressTracker<I>;
  readonly rows: Effect.Effect<ReadonlyMap<I, Row>>;
}

// Fast, in-memory ProgressTracker double for Bun unit tests - no ProgressTableNotReady path since
// there's no "table" to be missing; that path is covered by postgres-progress-tracker.test.ts
// against a real Postgres instance.
export const makeInMemoryProgressTracker = <I>(): Effect.Effect<InMemoryProgressTrackerHandle<I>> =>
  Effect.gen(function* () {
    const ref = yield* Ref.make<Map<I, Row>>(new Map());

    const getLastPosition = (id: I): Effect.Effect<bigint> =>
      Effect.map(Ref.get(ref), (m) => m.get(id)?.lastPosition ?? 0n);

    const updateProgress = (id: I, position: bigint): Effect.Effect<void> =>
      Ref.update(ref, (m) => {
        const row = m.get(id);
        if (!row) return m;
        const next = new Map(m);
        next.set(id, { ...row, lastPosition: position });
        return next;
      });

    const recordError = (id: I, _error: string, maxErrors: number): Effect.Effect<void> =>
      Ref.update(ref, (m) => {
        const row = m.get(id);
        if (!row) return m;
        const errorCount = row.errorCount + 1;
        const next = new Map(m);
        next.set(id, { ...row, errorCount, status: errorCount >= maxErrors ? "FAILED" : row.status });
        return next;
      });

    const resetErrorCount = (id: I): Effect.Effect<void> =>
      Ref.update(ref, (m) => {
        const row = m.get(id);
        if (!row) return m;
        const next = new Map(m);
        next.set(id, { ...row, errorCount: 0 });
        return next;
      });

    const getStatus = (id: I): Effect.Effect<ProcessorStatus> =>
      Effect.map(Ref.get(ref), (m) => m.get(id)?.status ?? "ACTIVE");

    const setStatus = (id: I, status: ProcessorStatus): Effect.Effect<void> =>
      Ref.update(ref, (m) => {
        const row = m.get(id);
        if (!row) return m;
        const next = new Map(m);
        next.set(id, { ...row, status });
        return next;
      });

    const autoRegister = (id: I, instanceId: string): Effect.Effect<void> =>
      Ref.update(ref, (m) => {
        if (m.has(id)) return m;
        const next = new Map(m);
        next.set(id, { status: "ACTIVE", lastPosition: 0n, errorCount: 0, instanceId });
        return next;
      });

    const tracker: ProgressTracker<I> = {
      getLastPosition,
      updateProgress,
      recordError,
      resetErrorCount,
      getStatus,
      setStatus,
      autoRegister
    };

    return { tracker, rows: Ref.get(ref) };
  });
