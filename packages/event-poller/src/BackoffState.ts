// Port of com.crablet.eventpoller.internal.BackoffState - exact algorithm port. Java mutates
// instance fields; the Effect-idiomatic equivalent is an immutable value plus pure transitions,
// with the caller (the per-processorId loop in EventProcessor.ts) holding current state in a Ref.
//
// shouldSkip() is deliberately not ported - it's dead code in the real Java implementation too
// (the impl always calls process(), it only widens the delay before the next call via
// getNextDelayMs()/nextDelayMs()).
//
// PATTERN PRIMER - "functional core, imperative shell", the FP-flavored alternative to Java's
// mutable class here. Instead of one object whose `emptyPollCount`/`skipCounter` fields get
// updated in place by method calls (`state.recordEmpty()`), this is a plain immutable value
// (`BackoffState`) plus pure functions that take a state and return a *new* one
// (`recordEmpty(state, params) -> BackoffState`), never touching the input. Nothing here is
// Effect-specific - it's ordinary functional-programming style, chosen because it's trivially
// testable (see backoff-state.test.ts: call a function, compare the returned value, no setup/
// teardown of mutable fixtures) and because it composes cleanly with `Ref` (see
// EventProcessor.ts's primer): the "impure shell" is a `Ref<BackoffState>` that gets updated by
// calling these pure functions and storing the result back, exactly like `Ref.update(ref, (s) =>
// recordEmpty(s, params))`. The pure "what's the next state" logic and the impure "where does the
// current state live, and how does it get shared across fibers" concern are cleanly separated.
export interface BackoffState {
  readonly emptyPollCount: number;
  readonly skipCounter: number;
}

export interface BackoffParams {
  readonly threshold: number;
  readonly multiplier: number;
  readonly pollingIntervalMs: number;
  readonly maxBackoffSeconds: number;
}

export const init = (): BackoffState => ({ emptyPollCount: 0, skipCounter: 0 });

export const recordEmpty = (state: BackoffState, p: BackoffParams): BackoffState => {
  const emptyPollCount = state.emptyPollCount + 1;
  if (emptyPollCount <= p.threshold) {
    return { emptyPollCount, skipCounter: state.skipCounter };
  }
  const maxSkips = Math.floor((p.maxBackoffSeconds * 1000) / p.pollingIntervalMs);
  const exponent = emptyPollCount - p.threshold;
  const skipCounter = Math.min(Math.pow(p.multiplier, exponent) - 1, maxSkips);
  return { emptyPollCount, skipCounter };
};

export const recordSuccess = (): BackoffState => init();

export const nextDelayMs = (state: BackoffState, pollingIntervalMs: number): number =>
  pollingIntervalMs * (state.skipCounter + 1);
