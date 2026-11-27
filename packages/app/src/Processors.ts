import { Effect, Layer, type Duration } from "effect";
import type { SqlClient } from "effect/sql";
import { monitorStorage } from "@crablet/eventstore/Storage";
import type { LeaderOptions } from "@crablet/eventstore/Leader";
import { defaultInstanceId } from "@crablet/event-poller/InstanceId";
import { monitorProcessors } from "@crablet/event-poller/MonitorProcessors";
import type { PollingSettings } from "@crablet/event-poller/ProcessorConfig";
import type { ProcessSettings } from "@crablet/event-poller/ProcessSettings";
import type { BuiltModule, RunnableModule } from "@crablet/modules/Module";
import { Processors } from "@crablet/modules/Processors";
import { ProcessIdentityRef, type ProcessIdentity } from "./Product.ts";


// The modules of an application, declared once and shared by every process that builds them: a plain value (it opens no connection and builds no
// publisher), so the API and the workers import the same declaration. Built one module at a time, so each step's type is checked: the kinds, and what
// building and running the modules need, are the union of each module's (never written by hand), and a second module of a kind already declared does not
// compile when the kinds are literal (when they are not, `with` refuses it when it is called).
export interface Modules<Kind extends string, MakeR, RunR> {
  readonly list: ReadonlyArray<RunnableModule<Kind, MakeR, RunR, ProcessSettings>>;
  readonly with: <K extends string, MR, RR>(
    module: RunnableModule<K, MR, RR, ProcessSettings> &
      // a repeated literal kind; a kind typed `string` (on either side) is checked by `with` when it is called
      (string extends Kind | K ? unknown : [K] extends [Kind] ? { readonly error: `a module of kind "${K}" is already declared` } : unknown)
  ) => Modules<Kind | K, MakeR | MR, RunR | RR>;
}

const modulesOf = <Kind extends string, MakeR, RunR>(list: ReadonlyArray<RunnableModule<Kind, MakeR, RunR, ProcessSettings>>): Modules<Kind, MakeR, RunR> => ({
  list,
  with: <K extends string, MR, RR>(module: RunnableModule<K, MR, RR, ProcessSettings>) => {
    const kinds: ReadonlyArray<string> = list.map((m) => m.kind);
    if (kinds.includes(module.kind)) throw new Error(`Crablet.modules: two modules of kind "${module.kind}"; a process has one module of each kind`);
    const next: ReadonlyArray<RunnableModule<Kind | K, MakeR | MR, RunR | RR, ProcessSettings>> = [...list, module];
    return modulesOf(next);
  }
});

// `Crablet.modules(Views.module(...)).with(Automations.module(...))`.
export const modules = <Kind extends string, MakeR, RunR>(first: RunnableModule<Kind, MakeR, RunR, ProcessSettings>): Modules<Kind, MakeR, RunR> => modulesOf([first]);

// The process's settings, given to every module: one instance id, one set of leader settings, one polling default (a module's own config overrides it).
export interface ProcessOptions {
  readonly instanceId?: string | undefined;
  readonly leader?: LeaderOptions | undefined;
  readonly polling?: PollingSettings | undefined;
  // How often the consumer gauges (lag, cursor, status) are sampled for the modules this process runs. Default: 15 seconds.
  readonly monitorEvery?: Duration.Input | undefined;
}

// With the process's identity (`Crablet.layer(pg, { product })`), its instance is the modules' instance id and its product is given to their leaders,
// which report a lock held by another product's session.
const settingsOf = (options: ProcessOptions, identity: ProcessIdentity | null): ProcessSettings => ({
  instanceId: options.instanceId ?? identity?.instance ?? defaultInstanceId(),
  leader: identity === null ? options.leader : { ...options.leader, application: identity.product },
  polling: options.polling
});

const serviceOf = (built: ReadonlyArray<BuiltModule>, running: ReadonlySet<string>) =>
  Processors.of({
    sources: built.map((b) => b.source),
    status: Effect.forEach(built, (b) => Effect.map(b.isLeader, (leads) => ({ kind: b.kind, runs: running.has(b.kind), leads })))
  });

// Every module built, and those in `run` started, as the `Processors` service. The process runs the modules in `run` (by default all of them); the
// others are built and not run, so the admin API still lists and controls them through the database (ADR-0022, decision 4). The consumer gauges are
// sampled for the modules that run, and the storage gauges if any does. Closing the layer stops the modules and releases their locks; provided on top of
// the database layer, it closes before the pool. Provide it once, at the top: provided twice, it builds two sets of processors.
export const processors = <Kind extends string, MakeR, RunR>(
  { list: declared }: Modules<Kind, MakeR, RunR>,
  options: ProcessOptions & { readonly run?: ReadonlyArray<NoInfer<Kind>> | undefined } = {}
): Layer.Layer<Processors, never, MakeR | RunR | SqlClient.SqlClient> =>
  Layer.effect(
    Processors,
    Effect.gen(function* () {
      const settings = settingsOf(options, yield* ProcessIdentityRef);
      const running = new Set<string>(options.run ?? declared.map((m) => m.kind));
      // the modules take independent locks, so they are built and started together: the start is the slowest one, not the sum
      const built = yield* Effect.forEach(declared, (m) => (running.has(m.kind) ? m.start(settings) : m.make(settings)), { concurrency: "unbounded" });
      const sampled = built.filter((b) => running.has(b.kind)).map((b) => b.source.service);
      yield* Effect.logInfo(`crablet: this process runs ${[...running].join(", ") || "no module"}; builds ${declared.map((m) => m.kind).join(", ")}`);
      if (sampled.length > 0) {
        yield* Effect.forkScoped(monitorProcessors(sampled, { instanceId: settings.instanceId, ...(options.monitorEvery === undefined ? {} : { every: options.monitorEvery }) }));
        yield* Effect.forkScoped(monitorStorage());
      }
      return serviceOf(built, running);
    })
  );

// Every module built and none run, as the `Processors` service: for a process that serves the admin API and the status of modules other processes run
// (an API deployment, ADR-0022). It needs only what building needs (the SQL client), and builds no publisher.
export const catalog = <Kind extends string, MakeR, RunR>(
  { list: declared }: Modules<Kind, MakeR, RunR>,
  options: Pick<ProcessOptions, "instanceId" | "leader" | "polling"> = {}
): Layer.Layer<Processors, never, MakeR> =>
  Layer.effect(
    Processors,
    Effect.gen(function* () {
      const settings = settingsOf(options, yield* ProcessIdentityRef);
      const built = yield* Effect.forEach(declared, (m) => m.make(settings), { concurrency: "unbounded" });
      return serviceOf(built, new Set());
    })
  );
