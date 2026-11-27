# Configuration

*Reference · developers and operators · [Run it in production](../guides/operate/run-in-production.md) · look up*

What the framework's layer accepts, and the environment variables of the wallet example, which is the reference for a deployed application. How to
choose values: [Configure it](../guides/operate/configure.md).

## `Crablet.layer(pg, options)`

From `@crablet/app`. It provides `CommandExecutor`, `EventStore`, `CommandAuditStore` and the database clients.

`pg` is the connection, as `PgClient.layer` takes it (`@effect/sql-pg`): `host`, `port`, `database`, `username`, `password` (a `Redacted`), and
`maxConnections` for the pool.

| Option | Default | What it does |
|---|---|---|
| `eventStore.wakeupMode` | `"coalesced"` | How appends wake the pollers. `coalesced`: one notification per window, after the commit. `off`: none; the pollers see new events on their interval, and the views, automations and outbox modules do not `LISTEN` ([ADR-0021](../adr/0021-wakeups-after-commit-and-coalesced.md), [ADR-0028](../adr/0028-settings-the-framework-decides.md)). |
| `eventStore.wakeupWindowMs` | `50` | The coalescing window. `0` sends after each commit without waiting. |
| `eventStore.maxAppendEvents` | `50` | The most events one append takes; more are refused with `AppendTooLarge` before any SQL runs. A larger batch holds the writer locks for longer ([keep an append small](../guides/operate/run-in-production.md#keep-an-append-small)). |
| `audit.payload` | `"redacted"` | What the command audit stores of each input: `redacted` (fields marked `personal(...)` replaced), `full`, `none` (no payload), or `off` (no audit). |
| `session` | none | A direct connection, same shape as `pg`, for what cannot go through a pooler in transaction mode: the leader locks and `LISTEN`. Omitted, they use `pg` ([ADR-0024](../adr/0024-session-connections-for-leader-and-listen.md)). Its `maxConnections` must cover what the process keeps for good (5 for the three modules and the api: one lock session for every module, a `LISTEN` each, and the api's hub; 1 for the api alone; the deadlines processor adds none); the framework counts it as the modules start and warns once if the pool is smaller. |

Processor settings (polling, backoff, `maxErrors`, the leader retry) are in [Views](./views.md#processor-settings). Read-consistency settings are in
[HTTP](./http.md#read-consistency).

## Polling settings

How a processor polls, backs off and gives up, in `PollingConfig` (`Crablet.PollingConfig`, with `Crablet.defaultPollingConfig`). The views, automations and outbox modules each take a
`PollingSettings` as `config`, or none: what is left out, or given as `undefined`, takes the default below ([ADR-0030](../adr/0030-one-polling-config.md)). The deadlines module takes
a `DeadlinesConfig`: the same, plus `fireTimeoutMs`, how long one deadline's command may take (30 s by default).

```ts
Views.module({ views });                                                        // all defaults
Views.module({ views, config: { pollingIntervalMs: 200 } });                    // one setting changed, for every view
Views.module({ views, overrides: { "wallet-statement-view": { batchSize: 100 } } }); // one view's setting, by its name
Crablet.processors(modules, { polling: { pollingIntervalMs: 200 } });          // the process's default, for every module (a module's `config` wins)
```

| Setting | Default | What it does |
|---|---|---|
| `pollingIntervalMs` | `1000` | How often the processor polls while events keep coming (also the wait when it first goes idle). |
| `batchSize` | `100` | The most events handled in one batch (one transaction for a view). |
| `backoffEnabled` | `true` | Whether an idle processor waits longer between polls. |
| `backoffThreshold` | `3` | Empty polls before the wait starts to grow. |
| `backoffMultiplier` | `2` | How much the wait grows each time. |
| `backoffMaxSeconds` | `10` | The longest an idle processor waits between polls. A wake-up ends the wait. This bounds the delay if a wake-up is lost ([ADR-0021](../adr/0021-wakeups-after-commit-and-coalesced.md)). |
| `maxErrors` | `10` | Errors in a row before the processor is marked `FAILED` and stops. |
| `leaderElectionRetryIntervalMs` | `5000` | How often a follower tries to take the module's lock. Bounds the takeover after a crash. |

The outbox module's `OutboxConfig` adds one setting of its own:

| Setting | Default | What it does |
|---|---|---|
| `publishTimeoutMs` | `30000` | How long one call to a publisher's `publishBatch` may take before it counts as a failure (and toward `maxErrors`). Without it a destination that hangs would hold its topic back for good. A timed-out publish may have reached the destination, so the events are published again ([ADR-0036](../adr/0036-outbox-delivery-event-id-timeout-and-partial-progress.md)). |

The deadlines module's `DeadlinesConfig` (`@crablet/deadlines`) takes the same settings except the four backoff ones: it does not back off,
because no wake-up ends a wait (a new event makes nothing due; time does). Its interval defaults to **5000** instead: it is how late a deadline can fire
after it is due, and deadlines are business time; an idle poll is one index lookup, on the leader only. Its batch is fired one deadline at a time, so a
backlog (many deadlines due at the same instant) drains at about `batchSize` per interval ([ADR-0043](../adr/0043-a-deadline-is-an-event-in-the-log.md)). It adds one setting of its own:

| Setting | Default | What it does |
|---|---|---|
| `fireTimeoutMs` | `30000` | How long one deadline's command may take, its conflict retries included, before the firing counts as a failure (and toward `maxErrors`). Without it a command that hangs would hold back the deadlines after it for good. A timed-out command may have committed, so the deadline fires again, and its command's `idempotentBy` answers the repeat. |

A single view, automation or topic publisher can override `pollingIntervalMs`, `batchSize` and the four backoff settings of its own; `maxErrors` and the leader retry
belong to the module (the leader retry is not part of a processor's config at all: there is one leader lock per module). A module's processors can be stopped at run time by pausing them ([runbooks](../guides/operate/runbooks.md)), and a process starts only some
modules by role.

## `Crablet.config(prefix, options)`: the settings from the environment

`@crablet/app` reads a process's settings with Effect's `Config`, under the product's prefix (`WALLET` gives `WALLET_DB_HOST`). Each part comes from its
owner, and an application with names of its own composes the parts instead: `Crablet.databaseConfig(defaults)`, `Crablet.rolesConfig(appRoles)`,
`Crablet.migrateConfig`, `Crablet.pollingConfig` and `Crablet.wakeupsConfig`.
A blank variable counts as unset. A bad value is a `ConfigError` that names the variable (`at ["WALLET"]["DB_POOL"]`), and the process does not start.

| Variable (under the prefix) | Default | What it does |
|---|---|---|
| `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`, `DB_PASSWORD` | `localhost`, `5432`, then what the call gives (`options.database`); without it, required | The database connection. The password is `Redacted`. |
| `DB_URL` | unset | `postgres://user:password@host:port/database`, as platforms give it. When set, it wins over the parts. |
| `DB_POOL` | the library's default (10) | The most connections the pool opens, at least 1 ([size the pool](../guides/operate/run-in-production.md#size-the-pool)). |
| `DB_SESSION_HOST` and `_PORT`, `_NAME`, `_USER`, `_PASSWORD` | unset: share the main connection | A direct connection for the leader locks and `LISTEN`, while `DB_HOST` points at a pooler in transaction mode. Each part falls back to the main one. |
| `DB_SESSION_POOL` | `10` | The session pool, at least 1. It must cover what the roles keep for good. |
| `ROLES` | `all` | What this process runs ([ADR-0022](../adr/0022-runtime-roles.md)): a comma-separated list of the application's own roles (`options.roles`) and module kinds, or `all`. `Crablet.processorsFor(modules, settings.roles)` checks the kinds against the declaration and fails with `UnknownRole` (the name, and every valid role). An empty entry is a `ConfigError`. |
| `MIGRATE` | `on` | `off`: this process applies no migration; a pre-deploy job does ([ADR-0022](../adr/0022-runtime-roles.md), decision 6). |
| `PRODUCT` | the call's `product` | The product this process belongs to: its connections are named `<product>/<instance>` in `pg_stat_activity`, and a module that finds its lock held by another product's process logs an error naming it ([ADR-0054](../adr/0054-the-modules-declared-once-run-or-listed.md), V5). No `/`. Unset with no `product` in the call: the process is not named. |
| `POLL_MS` | `1000` | How often the processors poll while there are events, at least 50. |
| `BACKOFF_MAX_SECONDS` | `10` | The most an idle processor waits between polls, at least 1. |
| `WAKEUPS` | `coalesced` | `coalesced` or `off` (see `eventStore.wakeupMode`). |

The result feeds the rest: `Crablet.layer(settings.pg, settings.options)`, `Crablet.processorsFor(modules, settings.roles, { polling: settings.polling })`,
and `migrateIfFresh(Crablet.plainConnection(settings.pg), app)` when `settings.migrate`.

## The wallet's environment variables

The wallet example reads the table above with the prefix `WALLET` (`examples/wallet-example-app/src/config.ts`: `api` is its own role, `views`,
`automations` and `outbox` its modules; the database defaults are `wallet_db`, `postgres`, `postgres`; the product is `wallet`). The course reads the connection, the roles (`api`, and its
modules `views` and `deadlines`), the polling, the wake-ups and the product (`course`) with the prefix `COURSES` (`courses_db`), and not `COURSES_MIGRATE`: it migrates with its script. The wallet also reads these of its own:

| Variable | Default | What it does |
|---|---|---|
| `PORT` | `8080` | The HTTP port. |
| `WALLET_PERIOD` | `month` | The statement period: `month`, or `minutes:N` (1 to 1440) for the kind lab. Choose it for a new database. |
| `WALLET_ADMIN_TOKEN` | unset: no admin API | Mounts the admin API at `/admin/processors` and the event log at `/admin/events` (on the `api` role), behind this bearer token. |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | unset: nothing exported | Exports metrics, spans and logs over OTLP, through `Crablet.observability` ([See it on a dashboard](../guides/operate/dashboard.md)); the course reads it too. |
| `OTEL_SERVICE_NAME` | the app's name | The service the series belong to. |
| `OTEL_SERVICE_INSTANCE_ID` | the host name (the pod's, on Kubernetes) | `service.instance.id`: each instance's own series, so `rate()` is right. |

## The wallet's health endpoints

Served by `healthRoutes` ([`@crablet/processors-http/Health`](../../packages/processors-http/README.md)); an application of your own gets the same three.

| Endpoint | Served by | Answers |
|---|---|---|
| `GET /healthz` | every role (a process without `api` serves only these three) | the process is alive; says nothing about the database or leadership |
| `GET /readyz` | every role (the lab probes it on the `api` role) | ready: a `SELECT 1` answered within 2 seconds, else `503` |
| `GET /status` | every role | JSON: the instance (`HOSTNAME`), uptime, and for each module whether it runs it and leads it now |
