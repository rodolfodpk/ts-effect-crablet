// Views module configuration. (No shared-fetch fields - that execution strategy is out of scope.)
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
