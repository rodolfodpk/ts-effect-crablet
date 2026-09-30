import { Clock, Duration, Effect, Exit, Metric } from "effect";

// One instrumented "operation" is three plain Metric values: Effect's `Metric.tagged`
// can only add a tag whose value is known up front, not one chosen after the wrapped effect
// finishes, so success/failure counts are two separate counters rather than one outcome-tagged
// counter. Equally queryable at a backend (two series instead of one tag-split series) - a
// deliberate "redesign, not transliteration" call, not a capability gap.
export interface OperationMetrics {
  readonly duration: Metric.Histogram<Duration.Duration>;
  readonly successes: Metric.Counter<number>;
  readonly failures: Metric.Counter<number>;
}

const withTags = <In, State>(
  metric: Metric.Metric<In, State>,
  tags: ReadonlyArray<readonly [string, string]>
): Metric.Metric<In, State> => tags.reduce((acc, [key, value]) => Metric.withAttributes(acc, { [key]: value }), metric);

// Wraps `effect` with duration (always recorded, success or failure) plus a success/failure count, optionally tagged (e.g. `[["view", viewName]]`) at the call
// site, since the tag value (view name, command type, ...) is only known there, not at the point
// each `OperationMetrics` triplet is defined as a module-level constant.
//
// Deliberately NOT `Metric.trackDuration` - that aspect is built on `Effect.tap`, which only runs
// on the *success* channel (confirmed against effect 3.21.4's own source,
// internal/metric.js's `trackDurationWith`), so it silently drops the failure-path timing. Measuring the start/end time by hand and dispatching on
// `Exit.isSuccess` (via `Effect.exit`, converting "fail" into a plain value instead of letting it
// propagate early) is what actually gets duration-on-failure right.
export const observe = <A, E, R>(
  metrics: OperationMetrics,
  effect: Effect.Effect<A, E, R>,
  tags: ReadonlyArray<readonly [string, string]> = []
): Effect.Effect<A, E, R> =>
  Effect.gen(function* () {
    const start = yield* Clock.currentTimeNanos;
    const exit = yield* Effect.exit(effect);
    const end = yield* Clock.currentTimeNanos;

    yield* Metric.update(withTags(metrics.duration, tags), Duration.nanos(end - start));
    yield* Metric.update(withTags(Exit.isSuccess(exit) ? metrics.successes : metrics.failures, tags), 1);

    return yield* exit;
  });
