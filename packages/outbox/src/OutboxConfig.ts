// Port of com.crablet.outbox.config.OutboxConfig (crablet.outbox.* properties), minus `fetchSize`
// (a JDBC fetch-size hint with no `pg`-driver equivalent worth adding) and minus `retryDelayMs`
// (declared in Java's config class but not actually wired into any retry loop there either - not
// porting a knob that does nothing upstream).
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
