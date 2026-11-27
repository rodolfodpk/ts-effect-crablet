// The application's wiring, one namespace: `import * as Crablet from "@crablet/app"`.
//   - `Crablet.layer(pg, options)`: the database clients, the event store, the audit store and the command executor; `{ product }` names the process.
//   - `Crablet.modules(...)`, `Crablet.processors(modules, { run })`, `Crablet.catalog(modules)`: the background modules, declared once, run or only listed
//     by each process (ADR-0022); `Crablet.processorsFor(modules, roles)` with `run` from the configuration.
//   - `Crablet.config(prefix, { roles, database })`: one process's settings from its environment, each part from its owner.
//   - `Crablet.observability(serviceName, { product })`: metrics, spans and logs over OTLP from the OTEL_* variables, each instance naming itself and its product.
// It depends on no module: each module package describes itself (`Views.module(...)`), and a process imports only the modules it declares.
export { layer, type CrabletOptions, type PgConfig, type Services } from "./Layer.ts";
export { catalog, modules, processors, type Modules, type ProcessOptions } from "./Processors.ts";
export { config, databaseConfig, migrateConfig, plainConnection, productConfig, rolesConfig, type ConfigOptions, type Connection, type DatabaseDefaults, type Roles, type Settings } from "./Config.ts";
export { processorsFor, runOf, UnknownRole } from "./Roles.ts";
export { applicationNameOf, ProcessIdentityRef, type ProcessIdentity } from "./Product.ts";
export { observability, observabilityConfig, otlpLayer, resourceOf, type ObservabilityOptions, type ObservabilitySettings } from "./Observability.ts";
export { polling as pollingConfig, type PollingFromConfig } from "@crablet/event-poller/Config";
export { defaultPollingConfig, type PollingConfig, type PollingSettings } from "@crablet/event-poller/ProcessorConfig";
export { wakeups as wakeupsConfig } from "@crablet/eventstore/Config";
