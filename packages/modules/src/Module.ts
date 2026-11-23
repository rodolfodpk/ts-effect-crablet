import type { Effect, Scope } from "effect";
import type { ProcessorSource } from "./ProcessorSource.ts";

// A module as one process holds it once built: its processors as a source (for the admin API and the gauges) and whether this process leads it now.
export interface BuiltModule<Kind extends string = string> {
  readonly kind: Kind;
  readonly source: ProcessorSource;
  readonly isLeader: Effect.Effect<boolean>;
}

// A module described to the application (views, automations, outbox, deadlines, or one of your own): its kind, and how to build it without running it.
// `MakeR` is what building needs (the SQL client: a module that is not running is read and controlled through the database). `Settings` are the
// process's (its instance id, its leader and polling settings), given by whoever builds the modules: the module itself does not choose them.
// A catalog of modules (a process that serves the admin API without running them) needs only this.
export interface ModuleDescriptor<Kind extends string = string, MakeR = never, Settings = unknown> {
  readonly kind: Kind;
  readonly make: (settings: Settings) => Effect.Effect<BuiltModule<Kind>, never, MakeR>;
}

// A module that can also run: `start` builds it and runs it, owned by the scope (closing the scope stops it and releases its lock). `RunR` is what
// running needs beyond building (an executor, a LISTEN client, publishers). A process that runs modules needs this.
export interface RunnableModule<Kind extends string = string, MakeR = never, RunR = never, Settings = unknown> extends ModuleDescriptor<Kind, MakeR, Settings> {
  readonly start: (settings: Settings) => Effect.Effect<BuiltModule<Kind>, never, MakeR | RunR | Scope.Scope>;
}
