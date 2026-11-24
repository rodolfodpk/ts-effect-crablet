import { Context, type Effect } from "effect";
import type { ProcessorSource } from "./ProcessorSource.ts";

// What one process says about one module: whether it runs it here, and whether it leads it now (a module that runs may be a standby: another instance
// holds its lock).
export interface ModuleStatus {
  readonly kind: string;
  readonly runs: boolean;
  readonly leads: boolean;
}

// The modules of one process, as their consumers need them: the sources the admin API lists and acts on, and the status a health check reports. The
// handles stay with whoever built them. A process that runs its modules and one that only catalogs them give the same service: listing, pausing,
// resuming and resetting go through the database either way.
export interface ProcessorsService {
  readonly sources: ReadonlyArray<ProcessorSource>;
  readonly status: Effect.Effect<ReadonlyArray<ModuleStatus>>;
}

export class Processors extends Context.Service<Processors, ProcessorsService>()("@crablet/modules/Processors") {}
