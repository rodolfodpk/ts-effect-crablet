import { Config, Schema } from "effect";
import { defaultPollingConfig } from "./ProcessorConfig.ts";

// What a process's polling is set to from its configuration (docs/guides/operate/run-in-production.md, "Polling and wake-ups"), for every module it runs:
//   POLL_MS              the interval between polls while there are events (default 1000, at least 50)
//   BACKOFF_MAX_SECONDS  the most an idle processor waits between polls (default 10, at least 1)
// A wake-up ends the wait early either way; these set the worst case when one is lost, and the load on the database when idle. Read it under the
// application's prefix (`Config.nested`); `Crablet.config` does.
export interface PollingFromConfig {
  readonly pollingIntervalMs: number;
  readonly backoffMaxSeconds: number;
}

const atLeast = (minimum: number, name: string, fallback: number) =>
  Config.schema(Schema.Int.check(Schema.isGreaterThanOrEqualTo(minimum)), name).pipe(Config.withDefault(fallback));

export const polling: Config.Config<PollingFromConfig> = Config.all({
  pollingIntervalMs: atLeast(50, "POLL_MS", defaultPollingConfig.pollingIntervalMs),
  backoffMaxSeconds: atLeast(1, "BACKOFF_MAX_SECONDS", defaultPollingConfig.backoffMaxSeconds)
});
