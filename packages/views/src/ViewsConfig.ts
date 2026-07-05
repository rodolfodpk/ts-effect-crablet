// Port of com.crablet.views.config.ViewsConfig (crablet.views.* properties), minus
// fetchBatchSize/sharedFetch - the shared-fetch execution strategy is explicitly out of scope for
// this phase (see the Phase 3 plan's "Explicitly out of scope" section).
export interface ViewsConfig {
  readonly enabled: boolean;
  readonly pollingIntervalMs: number;
  readonly batchSize: number;
  readonly backoffEnabled: boolean;
  readonly backoffThreshold: number;
  readonly backoffMultiplier: number;
  readonly backoffMaxSeconds: number;
  readonly leaderElectionRetryIntervalMs: number;
  readonly maxErrors: number;
}
