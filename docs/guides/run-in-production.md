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

**Connection poolers.** The held connections use session features: `LISTEN` and the session-level advisory lock that elects a leader. PgBouncer in transaction mode and RDS Proxy do not carry these (RDS Proxy pins
the session on `LISTEN` and on session-level advisory locks, [AWS documentation](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/rds-proxy-pinning.html); the transaction-level advisory locks the append uses are not
pinned). Today the process has one client for everything, so run it on direct connections, or on a session-mode pooler. Splitting the held connections from the work pool is not built.

What has **not** been measured: the effect of the pool size on throughput. A comparison of 10 against 30 on one laptop was inconclusive (the database and the views' backlog grew from run to run), so there is no recommended
number here beyond the arithmetic above.

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
  outboxPublishers?: ReadonlyArray<OutboxPublisher>
): Effect.Effect<BackgroundProcessors, never, SqlClient.SqlClient | PgClient.PgClient | EventStore | CommandAuditStore | CommandExecutor | Scope.Scope> =>
  Effect.acquireRelease(startBackgroundProcessors(instanceId, outboxPublishers), stopBackgroundProcessors);
```

## 4. Several instances

You can run more than one copy. Each **module** (the views, the automations, the outbox publishers) runs in **one** process at a time, the leader, chosen by a PostgreSQL advisory lock per module (all of a module's processors run together; [diagram](../architecture.md#one-lock-per-module-one-leader-per-lock)); the others retry
every `leaderElectionRetryIntervalMs` (5 s here) and take over, immediately after a graceful stop. Reads and commands run on every instance.

## 5. Before a deploy that changes an event

Run the wallet's [`verify-events.ts`](../../examples/wallet-example-app/scripts/verify-events.ts) against a copy of production data; it exits with 1 if any stored event can no longer be
read ([Evolving events](../evolving-events.md)). Then see [Monitor it](monitor-it.md).
