// Port of com.crablet.eventpoller.internal.BackoffState - exact algorithm port. Java mutates
// instance fields; the Effect-idiomatic equivalent is an immutable value plus pure transitions,
// with the caller (the per-processorId loop in EventProcessor.ts) holding current state in a Ref.
//
// shouldSkip() is deliberately not ported - it's dead code in the real Java implementation too
// (the impl always calls process(), it only widens the delay before the next call via
// getNextDelayMs()/nextDelayMs()).
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
