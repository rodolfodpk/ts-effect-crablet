// Automations module configuration. (No shared-fetch fields - that execution strategy is out of
// scope, as it is for views and outbox.)
export interface AutomationsConfig {
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
