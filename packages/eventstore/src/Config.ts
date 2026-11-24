import { Config } from "effect";

// WAKEUPS: how appends tell the processors about new events (EventStoreConfig.wakeupMode). `coalesced` (default): one notification per window, after
// the commit. `off`: none, and the processors do not LISTEN either; the polling interval is then the latency. Read it under the application's prefix
// (`Config.nested`); `Crablet.config` does.
export const wakeups: Config.Config<"coalesced" | "off"> = Config.Literals(["coalesced", "off"], "WAKEUPS").pipe(Config.withDefault("coalesced" as const));
