// How often the processors poll, and how far they back off when idle (docs/guides/run-in-production.md, "Polling and wake-ups"). Applies to all three modules.
// WALLET_POLL_MS: the interval between polls while there are events (default 1000). WALLET_BACKOFF_MAX_SECONDS: the most an idle processor waits between polls (default 10).
// A wake-up notification ends the wait early either way; these set the worst case when one is lost, and the load on the database when idle.
export interface Polling {
  readonly pollingIntervalMs: number;
  readonly backoffMaxSeconds: number;
  // false (WALLET_WAKEUPS=off): the processors do not LISTEN; they see new events only on their interval.
  readonly listenForWakeups?: boolean;
}
export const defaultPolling: Polling = { pollingIntervalMs: 1000, backoffMaxSeconds: 10 };

const wholeNumber = (name: string, value: string | undefined, fallback: number, min: number): number => {
  if (value === undefined || value.trim() === "") return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < min) throw new Error(`${name} must be a whole number of ${min} or more, got "${value}"`);
  return n;
};

export type WakeupMode = "coalesced" | "inline" | "off";
// WALLET_WAKEUPS: how appends tell the processors about new events. coalesced (default): one notification per 50 ms window, after the commit. inline: one inside every append (the old behavior).
// off: none, and the processors do not LISTEN either; the polling interval is then the latency.
export const wakeupModeFromEnv = (value: string | undefined = process.env["WALLET_WAKEUPS"]): WakeupMode => {
  if (value === undefined || value.trim() === "") return "coalesced";
  const mode = value.trim();
  if (mode !== "coalesced" && mode !== "inline" && mode !== "off") throw new Error(`WALLET_WAKEUPS must be coalesced, inline or off, got "${value}"`);
  return mode;
};

export const pollingFromEnv = (env: Record<string, string | undefined> = process.env): Polling => ({
  pollingIntervalMs: wholeNumber("WALLET_POLL_MS", env["WALLET_POLL_MS"], defaultPolling.pollingIntervalMs, 50),
  backoffMaxSeconds: wholeNumber("WALLET_BACKOFF_MAX_SECONDS", env["WALLET_BACKOFF_MAX_SECONDS"], defaultPolling.backoffMaxSeconds, 1)
});
