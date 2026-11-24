# @crablet/app

An application's wiring, in one namespace: `import * as Crablet from "@crablet/app"`. It depends on no module: each module package describes itself, and a
process imports only the modules it declares.

## What it gives you

- **`Crablet.layer(pg, options)`** - the database clients, the event store, the command audit store and the command executor, in one layer (moved here from
  `@crablet/commands/Crablet`, which no longer exists).
- **`Crablet.modules(Views.module(...)).with(Automations.module(...))`** - the background modules, declared once: a plain value (no connection, no publisher),
  shared by every process. Built one module at a time, so the kinds and what building and running need are read off the modules, and a second module of a kind
  already declared does not compile.
- **`Crablet.processors(modules, { run, polling, leader, instanceId })`** - every module built, those in `run` started (by default all), as the `Processors`
  service (`@crablet/modules/Processors`). Its layer needs what the modules need to run (an executor only if automations or deadlines are declared, the
  outbox's publishers only if an outbox is: `Outbox.publishers(topics, { kafka })`). It samples the consumer gauges for the modules it runs; closing it stops
  them and releases their locks.
- **`Crablet.catalog(modules)`** - every module built and none run, as the same `Processors` service: for a process that serves the admin API and the status of
  modules other processes run (an API deployment, [ADR-0022](../../docs/adr/0022-runtime-roles.md)). It needs only the SQL client, and builds no publisher.

- **`Crablet.config(prefix, { roles, database })`** (`/Config`) - one process's settings from its environment, with Effect's `Config`, under the product's
  prefix (`WALLET_DB_HOST`, `WALLET_ROLES`...): the connection (or `DB_URL`), the pool, the session connection, the polling, the wake-ups, the roles and
  whether to migrate. Each part comes from its owner and can be read alone (`databaseConfig`, `rolesConfig`, `migrateConfig`, `pollingConfig`,
  `wakeupsConfig`). The variables are in the [configuration reference](../../docs/reference/configuration.md#crabletconfigprefix-options-the-settings-from-the-environment).
- **`Crablet.processorsFor(modules, settings.roles, options)`** - `Crablet.processors` with `run` from the configuration. A role that is neither the
  application's nor a declared kind fails the layer with `UnknownRole`, naming it and the valid ones, before anything is built.

```ts
const declaration = Crablet.modules(Views.module({ views: shopViews }))
  .with(Automations.module({ automations: [welcome] }))
  .with(Outbox.module({ topics }));

// workers
const Workers = Crablet.processors(declaration, { run: ["views", "automations", "outbox"] }).pipe(
  Layer.provide(Outbox.publishers(topics, { kafka: makeKafkaPublisher() })),
  Layer.provideMerge(Crablet.layer(pg))
);
// the API
const Catalog = Crablet.catalog(declaration).pipe(Layer.provideMerge(Crablet.layer(pg)));

// or every process of one image, its roles from SHOP_ROLES
const settings = yield* Crablet.config("SHOP", { roles: ["api"] });
const Process = Crablet.processorsFor(declaration, settings.roles, { polling: settings.polling }).pipe(   // E: UnknownRole
  Layer.provide(Outbox.publishers(topics, { kafka: makeKafkaPublisher() })),
  Layer.provideMerge(Crablet.layer(settings.pg, settings.options))
);
```

The admin API (`adminApiLayer`, `@crablet/processors-http`) reads `Processors` from either.
