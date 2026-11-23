import type { LeaderOptions } from "@crablet/eventstore/Leader";
import type { PollingSettings } from "./ProcessorConfig.ts";

// What one process gives every module it builds: one instance id, one set of leader settings and one polling default per process (a module's own config
// overrides the polling). The modules' descriptors take these (`ModuleDescriptor<Kind, MakeR, ProcessSettings>`), and `@crablet/app` fills them.
export interface ProcessSettings {
  readonly instanceId: string;
  readonly leader?: LeaderOptions | undefined;
  readonly polling?: PollingSettings | undefined;
}
