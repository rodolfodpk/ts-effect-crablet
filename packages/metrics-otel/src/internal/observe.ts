import { Clock, Duration, Effect, Exit, Metric } from "effect";

// One instrumented "operation" is three plain Metric values: a duration, and success and failure as two counters rather than one counter with an
// outcome attribute. Effect 4 can add an attribute chosen after the effect finished (`Metric.withAttributes` at update time; ADR-0056 checked it
// for a timer, and the commands' `executions` use it); these keep two counters because the dashboard and the alerts read them by name.
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
