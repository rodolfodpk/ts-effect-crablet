# ADR-0054: The modules declared once, run or only listed by each process

## Status

**Accepted** (2026-11-23, the maintainer's plan for `@crablet/app`, phase 2a). Built: `@crablet/app` (`Crablet.layer`, `Crablet.modules`,
`Crablet.processors`, `Crablet.catalog`), `@crablet/modules` (the contracts), `@crablet/deadlines`, a `module()` in each module package, `healthRoutes` in `@crablet/processors-http/Health` (phase 2b), `Crablet.config` and `Crablet.processorsFor` (phase 2d); applications import nothing of `@crablet/event-poller`, and each module's processor builders and management service are internal (phase 3). Tests:
`packages/app/test/processors.types.ts`, `packages/app/test/integration/processors.test.ts`, `packages/app/test/integration/health.test.ts`, `packages/app/test/{config,roles}.test.ts`, `packages/processors-http/test/health{.test,.types}.ts`, `packages/*/test/processor-requirements.types.ts`,
`scripts/lock-keys.test.ts`, `scripts/app-dependencies.test.ts`, `packages/modules/test/contracts.test.ts`. Amends [ADR-0022](0022-runtime-roles.md)
(decision 4) and [ADR-0039](0039-a-topic-takes-its-publishers.md).

## Context

ADR-0022 lets one image run as several roles, and the infrastructure already keeps a module to one leader per database (its advisory lock), with one
lock session and one `LISTEN` per process (ADR-0046). What was missing was the framework owning the rules. The wallet's `WalletApp.ts` imported from 24
entry points of 8 packages and wrote them itself: which module starts for which role, the admin API's list of sources, which modules the gauges sample,
the status a health check reports. The course had no roles at all. Every application would write the same code, and each could get it wrong.

Four things in the packages stood in the way:

- A module's `make*` needed what only running uses (`makeAutomationsProcessor` needed the `CommandExecutor`, `makeDeadlinesProcessor` the
  `EventStore`), so a process that only lists the modules had to provide an executor it never runs (interface segregation).
- The lock keys of the four modules were in the event store's `Leader.ts`, so a new kind of module meant editing the event store (open/closed).
- The management service's contract lived in the engine (`@crablet/event-poller`), so the admin API depended on the engine (dependency inversion).
- `@crablet/automations` held two modules, automations and deadlines, each with its own lock and reasons to change (single responsibility).

## Decision

1. **Each module describes itself; the facade knows only the description.** A module package exports `module(options)`, a `RunnableModule<Kind,
   MakeR, RunR, ProcessSettings>`: its kind, `make` (build it, nothing runs) and `start` (build and run it, owned by the scope). The contracts are in
   `@crablet/modules`, which depends on nothing of the framework; `@crablet/app` depends on them and on no module, so an application of views installs
   no automations.
2. **Building needs the SQL client only; running needs what running needs.** A module that is not running is read and controlled through the database,
   so `make` needs `SqlClient`. What running needs is the handle's run requirement (`ProcessorHandle<R>`): `PgClient` for the wake-ups, the
   `CommandExecutor` for automations and deadlines, the `EventStore` for the deadlines' firings, `OutboxPublishers` for the outbox. The engine carries
   that `R` from the handler to `start`.
3. **The modules are declared once, as a value.** `Crablet.modules(Views.module(...)).with(Automations.module(...))` opens no connection and builds no
   publisher, so the API and the workers import the same declaration. It is built one module at a time because that is what the compiler can check:
   the kinds and the requirements are the union of each module's, and a second module of a kind already declared does not compile. A variadic
   `Crablet.modules(a, b, c)` was the plan's first shape; its requirements could only be stated with a cast on a `Layer` type, which `CLAUDE.md`
   forbids.
4. **A process runs some modules and lists all of them.** `Crablet.processors(declaration, { run })` builds every module and starts those in `run`
   (by default all); `Crablet.catalog(declaration)` builds every module and runs none. Both give the `Processors` service (`sources` for the admin API,
   `status` for health), and they are interchangeable: listing, pausing, resuming and resetting go through the database either way. This answers the
   question ADR-0022 left open in decision 4: a handle can be built without starting it (it opens no connection and runs no loop), so the `api` role
   serves the admin API for every module. The gauges are sampled for the modules a process runs.

   **A process that runs a fixed subset declares only that subset** (the maintainer's decision on a review finding, 2026-11-23, interface
   segregation). `Crablet.processors(declaration, { run })` needs what running every declared module needs, including those `run` leaves out: `run`
   serves the one-image model (ADR-0022), where the roles are read at start-up and any module may run, so every requirement is needed anyway. A worker
   that only ever runs the deadlines declares `Crablet.processors(Crablet.modules(Deadlines.module(...)))` and needs what the deadlines need, no
   publisher; the API lists everything with a catalog of the whole declaration. Typing the requirements by a literal `run` was the alternative: the body
   cannot show it to the compiler without an assertion on a `Layer` type.
5. **The admin API and the probes read the process's modules.** `adminApiLayer({ masks })` takes its sources from `Processors`, not from a list the application
   assembles. `healthRoutes({ ping, readyTimeout, instance })` (`@crablet/processors-http/Health`, phase 2b) serves `/healthz`, `/readyz` and `/status` from its
   `status`, with the rules ADR-0022 set: a standby is healthy, `/healthz` asks nothing of the database, `/readyz` has a generous timeout. They are routes, not a
   server: a worker serves them on the server the application provides, as the API does (ADR-0042), so no framework package depends on `@effect/platform-node`.
   `/status` answers in the framework's words (`kind`, `runs`, `leads`, the `instance`); the wallet's own shape (`module`, `leading`, `pod`, `roles`) is gone.
6. **A module owns its lock key.** `VIEWS_LOCK_KEY` and its siblings are in their modules, with the values they had: in a rolling deploy, old and new
   versions take the same lock. `Leader.ts` is only the mechanism.
7. **A topic names its publishers; running the outbox takes one per name** (ADR-0039, amended). A process that only lists the outbox's processors
   builds no client for the broker. The names must be literal for the compiler to check them; where they are not (publishers given for other topics, a
   hand-built `OutboxPublishers`), a missing one fails the outbox's start, naming it, instead of every poll of its pair.
8. **The deadlines are a module of their own** (`@crablet/deadlines`), sharing no code with the automations.
9. **`Crablet.layer` is the application's wiring and lives in `@crablet/app`.** `@crablet/commands` keeps the domain and the executor.

Rules this records, for every application:

- **One database per product.** The advisory locks, the `LISTEN` channels and the progress tables' names are database-wide: two products in one database
  would share them, and the second product's modules would wait as standbys for ever. A schema per product does not isolate them.
- **One product per Effect context.** Two `Crablet.layer`s in one context share the same tags, and one hides the other. In practice, one product per process.
- **Products talk by messages.** One product publishes through its outbox; another consumes and runs a command of its own. No product reads another's log.
- **A module is the unit of exclusion, and its lock is fixed by its kind.** A module's processors cannot be split across two deployments.
- **One leader setting, one polling default and one instance id per process,** given to every module (`ProcessSettings`); a module's `config` overrides the polling, and a setting it leaves `undefined` keeps the process's.

## Consequences

- An application declares its modules and says which a process runs; it no longer starts processors, builds handles or lists sources itself.
- `run` is typed by the declared kinds. Read from the environment (phase 2d), the roles are names: `Crablet.config` (`@crablet/app/Config`) reads
  `ROLES` without knowing the modules (a new kind needs no change to it) and keeps the application's own roles apart, and `Crablet.processorsFor`
  checks the others against the declaration, failing the layer with `UnknownRole` (in its `E`; `processors` with a literal `run` still cannot fail).
  It is a function of its own because one function whose `E` depended on the kind of `run` could not be written without an assertion on a `Layer`
  type. `Crablet.config` composes the `Config` of each owner (the connection here, the polling in `@crablet/event-poller/Config`, the wake-ups in
  `@crablet/eventstore/Config`); the product's name (V5) is not in it yet.
- **Breaking (pre-release, [ADR-0013](0013-api-evolution-additive-vs-breaking.md)):** `@crablet/commands/Crablet` (now `@crablet/app`),
  `@crablet/automations/Deadlines` (now `@crablet/deadlines`), `@crablet/event-poller/ProcessorStatus` (now `@crablet/modules`), the lock keys in
  `@crablet/eventstore/Leader`, `ProcessorSource` from `processors-http`, `defineTopic` with publisher objects, `OutboxPublisher.name`,
  `adminApiLayer({ sources })`, the wallet's `/status` shape (phase 2b).
- Provided twice, `Crablet.processors` builds two sets of processors. The re-entrance guard of ADR-0046 keeps them from both leading, but the loops and
  the samplers double: provide it once, at the top.

## Alternatives considered

- **The facade in `@crablet/event-poller`.** The engine is not what applications import (ADR-0031), and the contracts would depend on the engine.
- **The facade depending on every module.** Simpler to write; an application of views would install the automations, the outbox and the deadlines.
- **Profiles (an API package, a workers package).** `run` already chooses what a process runs; packages per profile would split the facade without
  removing a dependency.
- **The executor resolved when building, as before.** A catalog would need an executor and an event store it never uses.
- **A variadic `Crablet.modules`.** See decision 3.

## Not done here

- The product name in the connections and the detection of two products in one database (V5): decided (a) and done on 2026-11-27, see the update at the end.
- Merging partial declarations, one per vertical slice: with phase 3.

## Update: the product names the process, and a lock held by another product is reported (V5, 2026-11-27)

Decision V5 (a): the product is the application's configuration, and the event store takes only a name, as a parameter.

- **`Crablet.layer(pg, { product, instance })`** gives the process an identity (`ProcessIdentityRef`, `@crablet/app`; a `Context.Reference` with none
  by default). Its connections, the pool and the session ones, are named `<product>/<instance>` in `pg_stat_activity` (unless `pg.applicationName` is
  given), its modules use `instance` as their instance id (default `<hostname>-<pid>`, as before), and `Crablet.processors` gives the product to their
  leaders. `Crablet.config(prefix, { product })` reads `PRODUCT` over the name the call gives. A name that is blank or holds a `/` is refused.
- **`LeaderOptions.application`** (`@crablet/eventstore/Leader`): given, a module that does not get its lock looks who holds it. A session of another
  application is logged as an error naming it, once per holder (not on every retry); a standby of the same product says nothing; a holder that names
  no application is a warning. The look is best effort and never fails the attempt. The event store knows no product: it compares the holder's
  `application_name` with the name it is given.
- **Verified:** another database user's session shows its `application_name` without `pg_read_all_stats` (only its query is hidden; Postgres 18.6),
  so the detection works across database users (`packages/eventstore/test/integration/leader-foreign-holder.test.ts`).
- **Not done:** views of one product split across two deployments look like a normal standby and are not reported; isolation of products sharing a
  database (locks and channels derived from the product) stays a future ADR. The metrics carry the service name and instance from
  `Crablet.observability`; a `product` attribute on the poller's metrics was not added.
