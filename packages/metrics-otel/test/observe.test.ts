import { describe, expect, test } from "bun:test";
import { Effect, Metric } from "effect";
import { observe, type OperationMetrics } from "../src/internal/observe.ts";

// Fresh, uniquely-named metrics per test - Effect's Metric registry is global/module-level, so
// reusing one shared name across tests would let state bleed between them.
const freshMetrics = (): OperationMetrics => {
  const suffix = crypto.randomUUID();
  return {
    duration: Metric.timer(`test.observe.duration.${suffix}`),
    successes: Metric.counter(`test.observe.successes.${suffix}`),
    failures: Metric.counter(`test.observe.failures.${suffix}`)
  };
};

describe("observe", () => {
  test("records a success: increments successes, leaves failures at 0, records a duration sample", async () => {
    const metrics = freshMetrics();

    await Effect.runPromise(observe(metrics, Effect.succeed("ok")));

    const successes = await Effect.runPromise(Metric.value(metrics.successes));
    const failures = await Effect.runPromise(Metric.value(metrics.failures));
    const duration = await Effect.runPromise(Metric.value(metrics.duration));

    expect(successes.count).toBe(1);
    expect(failures.count).toBe(0);
    expect(duration.count).toBe(1);
  });

  test("records a failure: increments failures, leaves successes at 0, still records a duration sample", async () => {
    const metrics = freshMetrics();

    const exit = await Effect.runPromiseExit(observe(metrics, Effect.fail("boom")));
    expect(exit._tag).toBe("Failure");

    const successes = await Effect.runPromise(Metric.value(metrics.successes));
    const failures = await Effect.runPromise(Metric.value(metrics.failures));
    const duration = await Effect.runPromise(Metric.value(metrics.duration));

    expect(successes.count).toBe(0);
    expect(failures.count).toBe(1);
    expect(duration.count).toBe(1);
  });

  test("does not swallow or alter the wrapped effect's own result", async () => {
    const metrics = freshMetrics();
    const result = await Effect.runPromise(observe(metrics, Effect.succeed(42)));
    expect(result).toBe(42);
  });

  test("does not swallow or alter the wrapped effect's own failure", async () => {
    const metrics = freshMetrics();
    const exit = await Effect.runPromiseExit(observe(metrics, Effect.fail("original-error")));
    expect(exit._tag).toBe("Failure");
    if (exit._tag === "Failure") {
      expect(exit.cause._tag).toBe("Fail");
      if (exit.cause._tag === "Fail") {
        expect(exit.cause.error).toBe("original-error");
      }
    }
  });

  test("applies the given tags to duration/successes/failures alike", async () => {
    const metrics = freshMetrics();
    await Effect.runPromise(observe(metrics, Effect.succeed("ok"), [["view", "wallet-view"]]));

    const taggedSuccesses = await Effect.runPromise(
      Metric.value(Metric.tagged(metrics.successes, "view", "wallet-view"))
    );
    expect(taggedSuccesses.count).toBe(1);

    // The untagged base metric's own count is unaffected - the tag creates a distinct series.
    const untaggedSuccesses = await Effect.runPromise(Metric.value(metrics.successes));
    expect(untaggedSuccesses.count).toBe(0);
  });

  test("accumulates across multiple calls", async () => {
    const metrics = freshMetrics();
    await Effect.runPromise(observe(metrics, Effect.succeed("a")));
    await Effect.runPromise(observe(metrics, Effect.succeed("b")));
    await Effect.runPromiseExit(observe(metrics, Effect.fail("c")));

    const successes = await Effect.runPromise(Metric.value(metrics.successes));
    expect(successes.count).toBe(2);
  });
});
