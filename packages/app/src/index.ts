// The application's wiring, one namespace: `import * as Crablet from "@crablet/app"`.
//   - `Crablet.layer(pg, options)`: the database clients, the event store, the audit store and the command executor.
//   - `Crablet.modules(...)`, `Crablet.processors(modules, { run })`, `Crablet.catalog(modules)`: the background modules, declared once, run or only listed
//     by each process (ADR-0022).
// It depends on no module: each module package describes itself (`Views.module(...)`), and a process imports only the modules it declares.
export { layer, type CrabletOptions, type PgConfig, type Services } from "./Layer.ts";
export { catalog, modules, processors, type Modules, type ProcessOptions } from "./Processors.ts";
