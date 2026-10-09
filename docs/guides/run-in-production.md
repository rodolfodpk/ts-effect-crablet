# Run it in production

What an application has to do to run for real: apply the schema, open one connection layer, start the background processors, and stop them before the pool closes.
The example is the course app's [`index.ts`](../../examples/course-enrolment-app/src/index.ts).

[← Task guides](README.md)

## 1. Apply the migrations

The schema is a bundle of SQL files in [`@crablet/db-migrations`](../../packages/db-migrations/README.md); you apply them, then your own tables (numbered from V100).

<!-- file: examples/course-enrolment-app/src/migrate.ts#apply-migrations -->
```ts
for (const file of coreMigrationFiles) await client.query(readFileSync(path.join(coreSqlDir, file), "utf-8"));
for (const file of appMigrationFiles) await client.query(readFileSync(path.join(appMigrationDir, file), "utf-8"));
```

**There is no migration runner and no record of what was applied.** The example runs every file against a fresh database, and the files are not idempotent. For an
existing database you apply only the files it has not had, in order, with your own deployment tooling. V11 holds a lock on the events table while it backfills, so
writers pause for its duration: read its header before running it on a large log.

**Do not let every instance run the migration at start-up.** Five instances starting at once on an empty database raced: some failed with `relation ... already exists`, and which ones changed from run to run ([the kind lab](../plans/kind-lab.md)).
Run the schema from **one pre-deploy job**, and start the application with the migration off (the wallet: `WALLET_MIGRATE=off`). A migration tool with a history table and a lock removes the race: the files here already follow
Flyway's naming (the framework's are V1 to V13, so number your own from V100 and keep the range below 100 for the framework), and Flyway 13.10.0 applied both sets, in order, from five pods at once, three times out of three, on Postgres 18.6
(`examples/wallet-example-app/Dockerfile.migrations`). An existing database needs a baseline so the tool accepts the versions it already has; that was not tried.

## 2. One layer for the connection

<!-- file: examples/course-enrolment-app/src/index.ts#crablet-layer -->
```ts
const appLayer = Crablet.layer({
  host: conn.host,
  port: conn.port,
  database: conn.database,
  username: conn.username,
  password: Redacted.make(conn.password),
  // COURSES_DB_POOL: at most this many connections. Unset, the library's default applies.
  ...(poolSize === undefined ? {} : { maxConnections: poolSize })
});
```

The event store, the command executor and the audit store all come from this layer. Take the connection details from your environment, not from code.

### Size the pool

`maxConnections` (the examples read it from `COURSES_DB_POOL` and `WALLET_DB_POOL`) is the most connections this process opens. **Unset, it is the library's default of 10; that is not a figure anyone calibrated**
for Crablet, and nothing in the framework sets it. The examples log the size they run with at start-up.

The pool is shared by everything the process does with the database, and part of it is **held for good**:

| Uses a connection | How |
|---|---|
| a command | one connection for its whole transaction (load the model, decide, append), so a pool of *n* runs at most *n* commands at once |
| a read, a view projection, a cursor update, the metric samplers | for the length of the statement or transaction |
| the leader lock of a module | one connection, held while this process leads that module |
| `LISTEN` for event wake-ups | one connection per module, held for good, on followers too |
| `LISTEN` for view progress (the live feed and reads that wait) | one connection per process, held for good |

Measured on the wallet example (three modules, one idle instance against Postgres 18.6): the **leader held 7 connections for good** (3 locks, 3 `LISTEN` for events, 1 for view progress) and a **follower held 4**
(the `LISTEN`s); with the default pool of 10 that leaves 3 for work on a leader. The total stayed at the pool size under load (10 with the default, 16 and 12 when set to those values). Those counts are today's
implementation, and they may shrink; check them with `select count(*) from pg_stat_activity` on your own deployment.

So size it as **what is held for good plus the concurrency of work you want**, and count the whole fleet against the server: *instances x pool* must stay under `max_connections` (100 on a stock Postgres; on RDS it depends on the
instance class) with room for migrations, `psql` and monitoring. A pool at or below the held count leaves nothing for work, and the process stalls rather than failing. A process that only runs processors needs a small
pool. A process that only serves commands and reads would, by the code, hold one connection for good (the view-progress `LISTEN`) and need a pool sized to its request concurrency; the examples always start the
processors, so this shape is allowed by the framework but neither shown nor measured.

**Connection poolers.** The held connections use session features: `LISTEN` and the session-level advisory lock that elects a leader. A pooler that multiplexes transactions (PgBouncer in transaction mode, RDS Proxy) cannot carry those without pinning the session to one backend connection; RDS Proxy pins on `LISTEN` and on session-level advisory locks ([AWS documentation](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/rds-proxy-pinning.html)), and does not pin on the transaction-level advisory locks the append uses. This was read from that documentation; it was not tested against a proxy.

Whether it matters depends on why you would use a pooler. A pooler earns its place when there are **many short-lived client connections** (functions, a large fleet, connection storms). A few instances with a fixed pool do not have that problem, and a pinned connection per instance is a rounding error against `max_connections`. So:

- **Workers** (`WALLET_ROLES=views,automations,outbox`) hold the leader lock, so they connect **directly** to Postgres. They need few, long connections; a pooler gains nothing for them.
- **The API** (`WALLET_ROLES=api`) may go through the proxy: commands and reads use short transactions and transaction-level locks. It still holds **one** `LISTEN` per process, for the hub that wakes reads waiting on a marker (ADR-0016), so each API instance pins one proxy connection. With a handful of instances that is a small cost and needs no change.
- Both are plain configuration: a different `WALLET_DB_HOST` per deployment ([ADR-0022](../adr/0022-runtime-roles.md)). A single process that wants a pooled path for commands and a direct one for the held connections would need the connection configuration split inside the process; that is not built, and nothing here asks for it yet.

If you would rather hold no `LISTEN` for event wake-ups at all, `WALLET_WAKEUPS=off` removes the notification and the processors' `LISTEN`; the polling interval is then the latency (see "Wake-ups"). That is a choice about predictable latency and a quieter database, not something a proxy forces on you: workers connect directly anyway. The hub's `LISTEN` (reads that wait) stays.

What has **not** been measured: the effect of the pool size on throughput. A comparison of 10 against 30 on one laptop was inconclusive (the database and the views' backlog grew from run to run), so there is no recommended
number here beyond the arithmetic above.

### Polling and wake-ups

Each processor polls the log by cursor, and a wake-up notification ends its wait early. Two settings decide how often the database is asked and how long an event can wait when no notification arrives:

| Setting (wallet) | What it sets | Default |
|---|---|---|
| `WALLET_POLL_MS` | the wait between polls while events keep coming (also the wait when a processor first goes idle) | 1000 |
| `WALLET_BACKOFF_MAX_SECONDS` | the longest an idle processor waits between polls. After 3 empty polls the wait doubles each time up to this (1 s, 1, 1, 2, 4, 8, ... so about 250 s to reach 120) | 10 |
| `WALLET_WAKEUPS` | `coalesced`, `inline` or `off` (see "Wake-ups" above) | `coalesced` |

Only the leader of each module polls (six processors in the wallet). A poll with nothing new is a cursor read and a progress check, and any notification resets the backoff. In your own application these are the `pollingIntervalMs` and `backoffMaxSeconds` of each module's config.

**Three profiles to start from.** Measured on the wallet (all six processors, Postgres 18.6, one laptop under Docker, `pg_stat_statements`; the experiment is `examples/wallet-example-app/diagnostics/polling-load.diagnostic.ts`). "Statements/s" is everything the database ran, so under load it is mostly the commands themselves; the idle rows are the cost of polling.

| Profile | `WALLET_POLL_MS` | `WALLET_BACKOFF_MAX_SECONDS` | Idle, statements/s | Reads of a write, no notifications: p50 / p95 | Worst case after a quiet spell, notification lost |
|---|---|---|---|---|---|
| **Bounded** (the default) | 1000 | 10 | 5.1 | 523 ms / 802 ms | up to 10 s |
| **Quiet** (the default before 2026-10-08) | 1000 | 120 | 3.4 (still falling: the 120 s wait is reached after about 250 s) | 513 ms / 772 ms | up to 120 s |
| **Relaxed** | 5000 | 60 | 3.2 | 2 519 ms / 5 015 ms | up to 60 s |

With notifications working (`coalesced`), the three profiles were **indistinguishable** at 2 and at 20 commands a second: a write was visible in a view after about 20 to 26 ms (p50) and 32 to 66 ms (p95), and the load was the same (about 107 statements/s at 2 commands/s and about 815 at 20). The profile only matters when a notification does not arrive: `wakeupMode: "off"`, a process that died between the commit and the send, or a dropped `LISTEN`.

How to choose:

- **Bounded** is the default, and the one to start with in production. At its ceiling an idle processor polls 6 times a minute (Quiet: once every two minutes); measured, that is about 1.7 more idle statements a second than Quiet for the whole wallet (5.1 against 3.4, the Quiet figure still falling). It caps the wait after a lost notification at 10 s instead of two minutes.
- **Quiet** is fine when the cost of a late event after a quiet spell does not matter, or when you read the idle load as the only thing to minimise.
- **Relaxed** halves the polling load with no notifications (30 against 55 statements/s at 2 commands/s) and makes the latency the interval (p50 2.5 s, p95 5 s). It is for a deployment that runs with `wakeupMode: "off"` and a relaxed need for freshness, or for a database you want to leave quiet.
- With `WALLET_WAKEUPS=off`, the interval **is** the latency: about half of `WALLET_POLL_MS` at p50 and the whole of it at p95 while events are flowing, and up to `WALLET_BACKOFF_MAX_SECONDS` after a quiet spell. Pick both from the freshness you need.

What these numbers do not say: the loads are light (2 and 20 commands a second, one instance), the idle figure was taken after 90 s so the Quiet row had not reached its ceiling, a laptop is not an RDS instance, and no run combined no notifications with 20 commands a second. Measure your own deployment: `pg_stat_statements` on the database and the `crablet.poller.*` metrics show what the processors really ask.

### Keep an append small

One append is one transaction that takes the writer lock and sends one wake-up, so a very large batch holds every other writer back for as long as it takes. `append` refuses more than `MAX_APPEND_EVENTS` (50) events
with a typed `AppendTooLarge` before any SQL runs (over HTTP it is a 500: the batch size is the code's choice, not the caller's). To write more, split it into several appends; each is atomic on its own, so decide
whether the rule you protect needs them in one command.

### Wake-ups

Pollers sleep between polls, and a `NOTIFY` wakes them early. Appends do not notify themselves: the event store collects what a transaction appended and sends **one** notification per 50 ms window, **after the commit** (`EventStoreConfig.wakeupWindowMs`; `wakeupMode: "inline"` brings back one `pg_notify` inside every append). This is what lifts the write ceiling from about 3 000 to about 5 800 appends a second on the laptop measured ([ADR-0021](../adr/0021-wakeups-after-commit-and-coalesced.md)). `CommandExecutor` does it for you. If you call `EventStore.append` inside a transaction of your own, wrap that transaction: `eventStore.withWakeups(sql.withTransaction(...))`; without it the wake-up goes out before your commit and a poller may wake, find nothing and sleep.

`wakeupMode: "off"` (`WALLET_WAKEUPS=off` in the wallet) sends nothing, and with `listenForWakeups: false` on the module configs the processors do not `LISTEN` either: new events are seen only when the polling interval comes round. Use it when you prefer a latency that is exactly the interval over a `NOTIFY` in the database.

A wake-up is only a hint, and the one place it can now be lost is a process that dies between the commit and the send. The pollers' idle backoff (`backoffMaxSeconds`, 10 in the wallet) is then the worst-case delay; raise it if idle polling matters more to you than that bound.

### Behind a pooler (PgBouncer, RDS Proxy)

A pooler in transaction mode lends a server connection for **one transaction**. Nearly everything Crablet does is a transaction and takes only transaction-level locks, so it works through
one: the appends, the commands, the pollers' queries, and a view's batch with its cursor. Two things do not, because they live on a connection for as long as the process holds a role:

- **a module's leader**, a session-level advisory lock on a reserved connection (`pg_try_advisory_lock`);
- **LISTEN**, the pollers' wake-ups and the views' progress pings.

Behind PgBouncer in transaction mode **neither fails loudly**. Measured (PgBouncer 1.26, a server pool of 4, Postgres in Docker): while one instance held a leader lock, a second took it in 11 of
40 tries and the first saw its own lock as lost in 40 of 40 checks; 0 of 20 notifications reached a LISTEN, with no error. The whole wallet with everything through the pooler
(`examples/wallet-example-app/diagnostics/pgbouncer-session.diagnostic.ts`): 15 of 15 commands followed by a consistent read failed with a 503 after the 5 s wait, because the views never caught up;
with the split below, 15 of 15 worked, p50 47 ms. (Run PgBouncer against the database's IPv4 address in Docker Desktop: with `host.docker.internal` it waits 15 s between server logins and runs everything one transaction at a time.)

**Give the leader and LISTEN a direct connection**, to the database's own endpoint (the writer, not a reader, not the pooler), and keep the pooler for the rest:

```ts
Crablet.layer(
  { host: "pgbouncer.internal", port: 6432, /* ...the application's connection, through the pooler */ },
  { session: { host: "db-writer.internal", port: 5432, /* ...the same database, direct */ maxConnections: 10 } }
);
```

`session` takes the same shape as the first argument. Omitted, the leader and LISTEN use the first connection, exactly as before. Its pool holds what the process keeps for good, which depends on the
roles it runs (measured idle): **all three workers and the api, 7** (3 leader locks, 3 `LISTEN` for event wake-ups, 1 for view progress); **the three workers, 6**; **one worker, 2** (its lock and its
`LISTEN`); **the api alone, 1**. The default of 10 leaves room for the attempts of the modules that do not lead. A smaller pool does not fail: what does not fit waits, and a module can be left without a
leader (a leader gives up after 10 s and logs why; a `LISTEN` that does not fit just waits and the process falls back to polling). Say how many your process keeps with `sessionHolds` and the layer warns when the pool is
smaller; the wallet works it out from its roles (`sessionConnectionsHeld`) and reads the connection from `WALLET_DB_SESSION_HOST` (and `_PORT`, `_NAME`, `_USER`, `_PASSWORD`, `_POOL`, each defaulting to the main one).
The pods need a route and a credential to the direct endpoint; if the database only accepts the pooler, this is not possible.
Applications that build the layers themselves provide `sessionClientsLayer(config)` (`@crablet/eventstore/SessionClients`) and `ViewProgressHubLive` finds it.

**RDS Proxy** does not break these but pins them: per the AWS documentation, LISTEN and session-level advisory locks pin a connection to the proxy, and transaction-level locks do not. `session` keeps
those few connections off the proxy. Not tested against a real RDS Proxy. Aurora Limitless supports neither LISTEN nor RDS Proxy. After a failover of the direct endpoint the leader notices through its heartbeat
and LISTEN reconnects with a wake-up for what it missed (tested locally, not against Aurora).

### A pod per role

The roles (`WALLET_ROLES`: `api`, `views`, `automations`, `outbox`, [ADR-0022](../adr/0022-runtime-roles.md)) can run as separate pods of the same image. Measured with one pod each for `views`, `automations` and
`outbox` and one `api` (plain Postgres, a pool of 30 each, 600 commands from 12 clients at once, the four in one Node process so the CPU was shared; the data came out consistent, and ten consistent reads through the
api pod, waiting for views that run in another pod, took 109 ms in all):

| Pod | Connections held for good | Peak connections | Peak busy |
|---|---|---|---|
| `views` | 2 (its leader lock, a `LISTEN`) | 6 | 5 |
| `automations` | 2 | 4 | 1 |
| `outbox` | 2 | 3 | 1 |
| `api` | 1 (the progress hub's `LISTEN`) | 30 (the pool's limit) | 12 to 13 (see below) |

- **The workers need no pooler.** One process with its own pool does not gain from multiplexing: point it straight at the database, and leader and `LISTEN` behave as on any Postgres. The default pool of 10 is enough for
  each (the busiest, `views`, peaked at 6). That is 13 connections at the peak for the three.
- **The api pods are where connections add up.** A command holds one connection for its whole transaction, **including the time it waits for the append's advisory lock**: with 12 requests in flight the pod had 12 to 13
  connections busy, and most of them were `active (waiting: Lock)` inside `append_events_if` (8 of 12 with deposits only, 12 of 12 with withdrawals and transfers, on 30 wallets). So a pod needs a pool as big as the
  commands it runs at once, and N pods ask the database for N times that. (A pool keeps its idle connections for 10 s: the 28 to 31 connections seen at the peak were 12 busy and the rest waiting to expire.) If N times the pool
  nears the database's `max_connections`, that is the reason for a pooler in front of the api pods only, with `session` giving each of them the 1 connection its `LISTEN` needs (without it that `LISTEN` is lost in silence, and by the code a read
  then waits for the safety interval instead of a ping; not measured).
- **RDS Proxy** would pin 2 connections per worker pod and 1 per api pod, which is nothing: with this layout it needs no `session` at all (from the AWS documentation; not tested against a real RDS Proxy).
- **A pod down delays only what is its own.** `views` down: strict reads wait 5 s and answer 503 with `Retry-After` (commands carry on); `automations` or `outbox` down: notifications and publications are late, nothing
  is lost. Each role's leader lock is then a safety net (one candidate) that still covers the overlap of a rolling update. A graceful stop hands the lock over in about 0.1 s; after a crash the new pod takes it at its next
  retry (5 s in the wallet).

## 3. Start the processors, serve, and fail loudly

Building a processor's layer does not process anything: `service.start` forks the fibers that do. Let a **Scope** own them: `service.startScoped` starts the processors and registers
their stop, so closing the scope interrupts the fibers, releases the leader lock and announces it, and it does so even if the program fails or is interrupted. The entry point below
is scoped and runs under `NodeRuntime.runMain`, which turns SIGINT and SIGTERM into an interrupt, so a deploy that stops the process stops the processors first, then closes the pool.

<!-- file: examples/course-enrolment-app/src/index.ts#launch -->
```ts
const program = Effect.gen(function* () {
  yield* startCourseViewsScoped(undefined, { viewDelayMs });
  yield* Effect.log(`course-enrolment-app listening on :${port}; database pool: ${poolSize === undefined ? "the library's default size" : `up to ${poolSize} connections`}`);
  yield* Layer.launch(server);
});

// The program is scoped, and `runMain` turns SIGINT and SIGTERM into an interrupt: the scope closes, the view processor stops and releases its leader lock (another instance
// takes over at once), and only then does the connection pool close. A failure is logged and ends the process with a non-zero code.
NodeRuntime.runMain(Effect.provide(Effect.scoped(program), appLayer) as Effect.Effect<void, never, never>);
```

The wallet wraps its three processors the same way (`service.start` and `service.stop` stay available for tests, and for callers that manage the lifetime themselves):

<!-- file: examples/wallet-example-app/src/WalletApp.ts#start-scoped -->
```ts
export const startBackgroundProcessorsScoped = (
  instanceId?: string,
  outboxPublishers?: ReadonlyArray<OutboxPublisher>,
  roles?: Roles,
  polling?: Polling
): Effect.Effect<BackgroundProcessors, never, SqlClient.SqlClient | PgClient.PgClient | EventStore | CommandAuditStore | CommandExecutor | Scope.Scope> =>
  Effect.acquireRelease(startBackgroundProcessors(instanceId, outboxPublishers, roles, polling), stopBackgroundProcessors);
```

## 4. Several instances

You can run more than one copy. Each **module** (the views, the automations, the outbox publishers) runs in **one** process at a time, the leader, chosen by a PostgreSQL advisory lock per module (all of a module's processors run together; [diagram](../architecture.md#one-lock-per-module-one-leader-per-lock)); the others retry
every `leaderElectionRetryIntervalMs` (5 s here) and take over, immediately after a graceful stop. Reads and commands run on every instance.

The same image can also run as **separate roles**, chosen at start-up (the wallet's `WALLET_ROLES`: `api`, `views`, `automations`, `outbox`, or `all`, the default): the API scales with load and holds no leader lock, and the workers keep each module's lock and its standby. They talk only through
Postgres. The schema is then applied by one job, not by the pods (`WALLET_MIGRATE=off`). The lab that runs this on a local cluster is [Run the kind lab](run-the-kind-lab.md); the design is [ADR-0022](../adr/0022-runtime-roles.md).

## 5. Before a deploy that changes an event

Run the wallet's [`verify-events.ts`](../../examples/wallet-example-app/scripts/verify-events.ts) against a copy of production data; it exits with 1 if any stored event can no longer be
read ([Evolving events](../evolving-events.md)). Then see [Monitor it](monitor-it.md).
