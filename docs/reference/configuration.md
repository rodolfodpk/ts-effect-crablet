# Configuration

*Reference · developers and operators · [Run it in production](../guides/operate/run-in-production.md) · look up*

What the framework's layer accepts, and the environment variables of the wallet example, which is the reference for a deployed application. How to
choose values: [Configure it](../guides/operate/configure.md).

## `Crablet.layer(pg, options)`

From `@crablet/commands/Crablet`. It provides `CommandExecutor`, `EventStore`, `CommandAuditStore` and the database clients.

`pg` is the connection, as `PgClient.layer` takes it (`@effect/sql-pg`): `host`, `port`, `database`, `username`, `password` (a `Redacted`), and
`maxConnections` for the pool.

| Option | Default | What it does |
|---|---|---|
| `eventStore.wakeupMode` | `"coalesced"` | How appends wake the pollers. `coalesced`: one notification per window, after the commit. `off`: none; the pollers see new events on their interval, and the views, automations and outbox modules do not `LISTEN` ([ADR-0021](../adr/0021-wakeups-after-commit-and-coalesced.md), [ADR-0028](../adr/0028-settings-the-framework-decides.md)). |
| `eventStore.wakeupWindowMs` | `50` | The coalescing window. `0` sends after each commit without waiting. |
| `audit.payload` | `"redacted"` | What the command audit stores of each input: `redacted` (fields marked `personal(...)` replaced), `full`, `none` (no payload), or `off` (no audit). |
| `session` | none | A direct connection, same shape as `pg`, for what cannot go through a pooler in transaction mode: the leader locks and `LISTEN`. Omitted, they use `pg` ([ADR-0024](../adr/0024-session-connections-for-leader-and-listen.md)). Its `maxConnections` must cover what the process keeps for good (7 for the three modules and the api, 1 for the api alone); the framework counts it as the modules start and warns once if the pool is smaller. |

Processor settings (polling, backoff, `maxErrors`, the leader retry) are in [Views](./views.md#processor-settings). Read-consistency settings are in
[HTTP](./http.md#read-consistency).

## Polling settings

How a processor polls, backs off and gives up, in `PollingConfig` (`@crablet/event-poller/ProcessorConfig`). The views, automations and outbox modules each take a
`Partial<PollingConfig>` as `config`, or none: what is left out takes the default below ([ADR-0030](../adr/0030-one-polling-config.md)).

```ts
makeViewsProcessor({ projectors, subscriptions });                                   // all defaults
makeViewsProcessor({ projectors, subscriptions, config: { pollingIntervalMs: 200 } }); // one setting changed
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

A single view, automation or topic publisher can override `pollingIntervalMs`, `batchSize` and the four backoff settings of its own; `maxErrors` and the leader retry
belong to the module (the leader retry is not part of a processor's config at all: there is one leader lock per module). A module's processors can be stopped at run time by pausing them ([runbooks](../guides/operate/runbooks.md)), and a process starts only some
modules by role.

## The wallet's environment variables

The wallet example (`examples/wallet-example-app/src/index.ts`) reads these. They are a model for your own application; the framework itself reads no
environment variable.

| Variable | Default | What it does |
|---|---|---|
| `WALLET_DB_HOST`, `WALLET_DB_PORT`, `WALLET_DB_NAME`, `WALLET_DB_USER`, `WALLET_DB_PASSWORD` | `localhost`, `5432`, `wallet_db`, `postgres`, `postgres` | The database connection. |
| `WALLET_DB_POOL` | the library's default (10) | The most connections the pool opens ([size the pool](../guides/operate/run-in-production.md#size-the-pool)). |
| `WALLET_DB_SESSION_HOST` and `_PORT`, `_NAME`, `_USER`, `_PASSWORD` | unset: share the main connection | A direct connection for the leader locks and `LISTEN`, while `WALLET_DB_HOST` points at a pooler in transaction mode. |
| `WALLET_DB_SESSION_POOL` | `10` | The session pool. It must cover what the roles keep for good. |
| `PORT` | `8080` | The HTTP port. |
| `WALLET_ROLES` | `all` | What this process runs: a comma-separated list of `api`, `views`, `automations`, `outbox`, or `all` ([ADR-0022](../adr/0022-runtime-roles.md)). An invalid value stops the start-up. |
| `WALLET_MIGRATE` | applies migrations to a fresh database | `off`: this process applies none; a pre-deploy job does. |
| `WALLET_POLL_MS` | `1000` | How often the processors poll while there are events. |
| `WALLET_BACKOFF_MAX_SECONDS` | `10` | The most an idle processor waits between polls. |
| `WALLET_WAKEUPS` | `coalesced` | `coalesced` or `off` (see `eventStore.wakeupMode`). |
| `WALLET_PERIOD` | `month` | The statement period: `month`, or `minutes:N` (1 to 1440) for the kind lab. Choose it for a new database. |
| `WALLET_ADMIN_TOKEN` | unset: no admin API | Mounts the processors admin API at `/admin/processors` (on the `api` role), behind this bearer token. |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | unset: nothing exported | Exports metrics, spans and logs over OTLP ([See it on a dashboard](../guides/operate/dashboard.md)). |

## The wallet's health endpoints

| Endpoint | Served by | Answers |
|---|---|---|
| `GET /healthz` | every role (a process without `api` serves only this and `/status`) | the process is alive; says nothing about the database |
| `GET /readyz` | the `api` role | ready: a `SELECT 1` answered within 2 seconds, else `503` |
| `GET /status` | every role | JSON: its roles, uptime, and for each module whether it runs it and leads it now |
