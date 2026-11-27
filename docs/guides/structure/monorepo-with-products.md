# Several products in one repository

*Guide · developers and architects · [run it in production](../operate/run-in-production.md) read · 15 minutes*

How to lay out a repository that holds more than one product (this one holds two, the wallet and the course), how a product is cut into vertical
slices, and how one product is deployed either as one image with roles or as separate apps. The rules come from what Crablet shares inside one
database and one Effect context; each one is checked against the code ([ADR-0054](../../adr/0054-the-modules-declared-once-run-or-listed.md)).

[← Task guides](../README.md)

## 1. The shape

```text
monorepo/
  products/
    wallet/
      slices/                 one folder per slice of the event model: what changes together
        open-wallet/          the command, its decide, its contract (and the events only it emits)
        deposit/ withdraw/ transfer-money/ close-wallet/
        wallet-balance/       a view (projector and migration) and the endpoint that reads it
        welcome-notification/ an automation and the command it runs
        index.ts              each slice exports its parts: commands, views, automations, deadlines, topics, routes
      shared/                 what slices really share: events several emit, models, tags
      processes.ts            Crablet.modules(...the slices' parts): a declaration, nothing runs
      migrations.ts           the ordered list of migrations (the .sql files live in the slices)
      apps/
        api/                  Crablet.layer, serveApi over the slices' commands, the read routes, healthRoutes; Crablet.catalog(processes)
        workers/              Crablet.processors(processes, { run, publishers }), healthRoutes
        migrate/              the pre-deploy job: migrate(conn, migrations) on the product's database
    course/
      ...                     the same shape, its own database
  contracts/                  optional: the schemas of the integration events one product publishes and another consumes
```

**The slice is the unit of code, the app is the unit of deploy.** A deployment cuts across the slices: a slice has code that runs in the api (its command,
its read) and code that runs in the workers (its projector, its automation). `processes.ts` and `serveApi` only gather what the slices export, so a new slice
is a folder and one line in each list. There is no `slice` concept in the framework: the course is laid out this way, each slice's `index.ts` listing
the views and deadline commands it brings ([`slices/payments/index.ts`](../../../examples/course-enrolment-app/src/slices/payments/index.ts)), and
`processes.ts` spreading them:

<!-- file: examples/course-enrolment-app/src/processes.ts#course-modules -->
```ts
// The course's two modules, declared once (ADR-0054), from what each slice lists. The views: the seats left (table operations) and who took which
// seat (its own SQL, through `raw`), off the same events. The deadlines (ADR-0043): when a subscription's payment window closes they run the release
// Subscribe set, when a course's readiness period ends the cancellation DefineCourse set, and the monthly fee's invoices and their due dates.
// A new slice is a folder and one entry here. One instance runs each module; the others wait on its lock.
export const courseModules = (options: CourseModulesOptions = {}) =>
  Crablet.modules(Views.module({ views: [...courseSeatsViews, ...courseEnrolmentsViews].map(delayedBy(options.viewDelayMs ?? 0)) }))
    .with(Deadlines.module({ commands: [...paymentsDeadlineCommands, ...confirmCourseDeadlineCommands, ...monthlyFeeDeadlineCommands] }));
```

Both examples are laid out this way, with `src/shared/` for the events several slices emit. Their HTTP reads stay in `src/api/`, because one group of
read endpoints serves the views of several slices. The wallet keeps its contracts together in `src/shared/WalletContracts.ts`, the public write API
in one file, where the shape above gives each slice its own.

## 2. Between products

1. **One database per product.** Inside one database everything that names something is shared: the advisory locks are fixed per kind of module (a second
   product's views would wait on the first one's lock for good, without an error), the `crablet_events` and `crablet_view_progress` channels are
   database-wide, and so are the names in the progress tables and the event types in the log. A schema per product (`search_path`) does not isolate them
   either: the locks and channels stay shared. The wallet uses `wallet_db`, the course `courses_db`. Name each product's processes
   (`Crablet.layer(pg, { product })`, or `PRODUCT`): their connections show as `<product>/<instance>` in `pg_stat_activity`, and a module that finds its
   lock held by another product's process logs an error naming it, so the mistake is not a silent standby. Give the same name to
   `Crablet.observability(serviceName, { product })`: it exports it as `service.namespace`, so one collector groups a product's deployments.
2. **One product per Effect context.** Two products' `Crablet.layer` in one context provide the same services (`EventStore`, `CommandExecutor`), and one
   hides the other. In practice, one product per process; a "shared workers" deployment for several small products is not supported.
3. **Products talk by messages only.** Product A publishes through its outbox ([ADR-0039](../../adr/0039-a-topic-takes-its-publishers.md)); product B consumes
   from the broker, or over HTTP, and runs a command of its own. No product reads another's log. Crablet has no inbox: consuming a message once and running a
   command for it is application code today.
4. **A typed client stays inside its product.** The TypeScript client of a product's API (its pages, a service of the same product) shares its types; another
   product calls it over HTTP from the OpenAPI description, so that their deploys stay independent ([two kinds of client](../../reference/http.md#two-kinds-of-client)).
5. **Settings and migrations per product.** The prefix of `Crablet.config` is the product (`WALLET_DB_HOST`, `COURSES_DB_HOST`,
   [configuration](../../reference/configuration.md)). `migrateIfFresh` looks for the event log only, which is right with one database per product and wrong
   for two sets of migrations in one database.

## 3. Inside a product: one image with roles, or separate apps

The modules are declared once (`processes.ts`); a process either runs some of them or only lists them. Both forms build the same `Processors` service, so
the admin API and `/status` work the same way in either ([ADR-0054](../../adr/0054-the-modules-declared-once-run-or-listed.md)).

- **One image, several roles** (what the examples do, [ADR-0022](../../adr/0022-runtime-roles.md)): every process runs the same entry point and its
  `<PRODUCT>_ROLES` picks what it runs; `Crablet.processorsFor(modules, settings.roles)` runs the modules named and lists the others
  ([run it in production](../operate/run-in-production.md#3-start-the-processors-serve-and-fail-loudly)).
- **Separate apps**: the api and the workers are their own entry points over the same declaration.

<!-- excerpt -->
```ts
// apps/api: serves the commands and the reads, and the admin API over every module, without running any (no publishers needed)
const apiProcessors = Crablet.catalog(walletModules);
// apps/workers: runs the modules (one Deployment, or one per `run`); the outbox's publishers exist only here
const workerProcessors = Crablet.processors(walletModules, { run: ["views", "outbox"] })
  .pipe(Layer.provide(Outbox.publishers(walletTopics, { LogPublisher: makeLogPublisher() })));
```

What each side needs, read off the code:

- **The workers** need `CommandExecutor` when they run automations or deadlines (those run commands), so they import the slices and `shared/` and use
  `Crablet.layer`. A worker that runs only views or the outbox needs no executor.
- **The api** reads views through the view objects (`makeConsistentRead` takes them), so it imports the read slices, but runs no projector. Its live feed
  hears the views' progress through Postgres ([ADR-0016](../../adr/0016-one-listen-per-process-for-view-progress.md)), so it works with the views in another
  deployment.
- **A process provides its processors layer once, at the top.** Provided twice, two sets of handles start; the lock keeps them from both leading, but the
  loops and samplers double ([ADR-0046](../../adr/0046-one-lock-session-per-process.md)).
- **The views of one product run in one deployment.** The lock is one per module, so splitting a product's views across two deployments (slow views apart)
  is not supported.

## 4. What an app imports

An app imports `@crablet/app`, the modules it uses (`@crablet/views`, `@crablet/automations`, `@crablet/outbox`, `@crablet/deadlines`) and the HTTP packages;
never the engine, `@crablet/event-poller`, nor an entry point a package lists as internal ([public API and plumbing](../../reference/README.md#public-api-and-plumbing),
[ADR-0031](../../adr/0031-api-and-plumbing-are-separate.md)). This repository holds its examples, tools and documents to that with
`scripts/public-api.test.ts`; a repository of products can run the same check over `products/*/apps` and `products/*/slices`.
