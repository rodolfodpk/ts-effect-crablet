import { describe, expect, test } from "bun:test";
import * as BackoffState from "../src/BackoffState.ts";

// Exact algorithm port of com.crablet.eventpoller.internal.BackoffState - table-driven against
// hand-computed values matching: maxSkips = floor(maxBackoffSeconds*1000/pollingIntervalMs);
// skipCounter = min(multiplier^(emptyPollCount-threshold) - 1, maxSkips) once emptyPollCount > threshold.
describe("BackoffState", () => {
  test("stays at skipCounter=0 while emptyPollCount <= threshold", () => {
    const params: BackoffState.BackoffParams = {
      threshold: 3,
      multiplier: 2,
      pollingIntervalMs: 1000,
      maxBackoffSeconds: 120
    };
    let state = BackoffState.init();
    state = BackoffState.recordEmpty(state, params);
    expect(state).toEqual({ emptyPollCount: 1, skipCounter: 0 });
    state = BackoffState.recordEmpty(state, params);
    expect(state).toEqual({ emptyPollCount: 2, skipCounter: 0 });
    state = BackoffState.recordEmpty(state, params);
    expect(state).toEqual({ emptyPollCount: 3, skipCounter: 0 });
  });

  test("grows exponentially once past threshold", () => {
    const params: BackoffState.BackoffParams = {
      threshold: 3,
      multiplier: 2,
      pollingIntervalMs: 1000,
      maxBackoffSeconds: 120
    };
    let state = BackoffState.init();
    for (let i = 0; i < 3; i++) state = BackoffState.recordEmpty(state, params);

    state = BackoffState.recordEmpty(state, params); // emptyPollCount=4, exponent=1
    expect(state).toEqual({ emptyPollCount: 4, skipCounter: 1 });

    state = BackoffState.recordEmpty(state, params); // emptyPollCount=5, exponent=2
    expect(state).toEqual({ emptyPollCount: 5, skipCounter: 3 });

    state = BackoffState.recordEmpty(state, params); // emptyPollCount=6, exponent=3
    expect(state).toEqual({ emptyPollCount: 6, skipCounter: 7 });
  });

  test("caps skipCounter at maxSkips", () => {
    const params: BackoffState.BackoffParams = {
      threshold: 1,
      multiplier: 10,
      pollingIntervalMs: 1000,
      maxBackoffSeconds: 2 // maxSkips = floor(2000/1000) = 2
    };
    let state = BackoffState.init();
    state = BackoffState.recordEmpty(state, params); // emptyPollCount=1 <= threshold
    expect(state.skipCounter).toBe(0);

    state = BackoffState.recordEmpty(state, params); // exponent=1 -> 10-1=9, capped to 2
    expect(state).toEqual({ emptyPollCount: 2, skipCounter: 2 });

    state = BackoffState.recordEmpty(state, params); // exponent=2 -> 99, still capped to 2
    expect(state).toEqual({ emptyPollCount: 3, skipCounter: 2 });
  });

  test("recordSuccess fully resets", () => {
    const params: BackoffState.BackoffParams = {
      threshold: 1,
      multiplier: 2,
      pollingIntervalMs: 1000,
      maxBackoffSeconds: 120
    };
    let state = BackoffState.init();
    state = BackoffState.recordEmpty(state, params);
    state = BackoffState.recordEmpty(state, params);
    expect(state.skipCounter).toBeGreaterThan(0);

    state = BackoffState.recordSuccess();
    expect(state).toEqual({ emptyPollCount: 0, skipCounter: 0 });
  });

  test("nextDelayMs = pollingIntervalMs * (skipCounter + 1)", () => {
    expect(BackoffState.nextDelayMs({ emptyPollCount: 0, skipCounter: 0 }, 1000)).toBe(1000);
    expect(BackoffState.nextDelayMs({ emptyPollCount: 5, skipCounter: 3 }, 1000)).toBe(4000);
    expect(BackoffState.nextDelayMs({ emptyPollCount: 5, skipCounter: 7 }, 500)).toBe(4000);
  });
});
