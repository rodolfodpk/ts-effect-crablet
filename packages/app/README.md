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
```

The admin API (`adminApiLayer`, `@crablet/processors-http`) reads `Processors` from either.
