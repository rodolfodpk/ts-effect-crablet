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
  password: Redacted.make(conn.password)
});
```

The event store, the command executor and the audit store all come from this layer. Take the connection details from your environment, not from code.

## 3. Start the processors, serve, and fail loudly

Building a processor's layer does not process anything: `service.start` forks the fibers that do. `service.stop` interrupts them, and must run before the pool closes
(the wallet's [`stopBackgroundProcessors`](../../examples/wallet-example-app/src/WalletApp.ts) does it for all three).

<!-- file: examples/course-enrolment-app/src/index.ts#launch -->
```ts
const program = Effect.gen(function* () {
  yield* startCourseViews(undefined, { viewDelayMs });
  yield* Effect.log(`course-enrolment-app listening on :${port}`);
  yield* Layer.launch(server);
});

Effect.runPromise(Effect.provide(program, appLayer) as Effect.Effect<void, never, never>).catch((error) => {
  console.error("FATAL", error);
  process.exit(1);
});
```

<!-- file: examples/wallet-example-app/src/WalletApp.ts#stop-processors -->
```ts
export const stopBackgroundProcessors = (processors: BackgroundProcessors): Effect.Effect<void> =>
  Effect.gen(function* () {
    yield* processors.viewsHandle.service.stop;
    yield* processors.automationsHandle.service.stop;
    yield* processors.outboxHandle.service.stop;
  });
```

## 4. Several instances

You can run more than one copy. Each view, automation and outbox runs in **one** process at a time, the leader, chosen by a PostgreSQL advisory lock; the others retry
every `leaderElectionRetryIntervalMs` (5 s here) and take over, immediately after a graceful stop. Reads and commands run on every instance.

## 5. Before a deploy that changes an event

Run the wallet's [`verify-events.ts`](../../examples/wallet-example-app/scripts/verify-events.ts) against a copy of production data; it exits with 1 if any stored event can no longer be
read ([Evolving events](../evolving-events.md)). Then see [Monitor it](monitor-it.md).
