// Views module configuration. (No shared-fetch fields - that execution strategy is out of scope.)
export interface ViewsConfig {
  readonly enabled: boolean;
  readonly pollingIntervalMs: number;
  // false: do not LISTEN for wake-ups (no connection held for it); the processor sees new events only on its polling interval. Use it with the event store's `wakeupMode: "off"`. Default true.
  readonly listenForWakeups?: boolean;
  readonly batchSize: number;
  readonly backoffEnabled: boolean;
  readonly backoffThreshold: number;
  readonly backoffMultiplier: number;
  readonly backoffMaxSeconds: number;
  readonly leaderElectionRetryIntervalMs: number;
  readonly maxErrors: number;
}
