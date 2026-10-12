// Outbox module configuration.
export interface OutboxConfig {
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
