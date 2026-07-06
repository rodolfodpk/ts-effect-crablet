// Port of com.crablet.automations.config.AutomationsConfig (crablet.automations.* properties),
// minus shared-fetch fields - the shared-fetch execution strategy is explicitly out of scope for
// this phase, matching views'/outbox's own deferral.
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
