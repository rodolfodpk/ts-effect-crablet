# Phase 0 Spike — Findings

Status: all acceptance criteria from the plan (`/Users/rodolfo/Documents/ts-effect-crablet-phase0-plan.md`)
met except where noted. 22/22 tests passing (12 under Bun, 10 under Node).

**Architectural decisions** made across all phases now live in [`docs/adr/`](docs/adr/README.md),
one file per decision. This file stays the phase-by-phase journal: status, gotchas, bugs found,
and what changed vs. each phase's plan.

## Runtime: Bun + Node hybrid, not Bun-only

`@testcontainers/postgresql` hangs indefinitely under Bun, so Testcontainers-backed tests run
under Node instead — see [ADR-0001](docs/adr/0001-hybrid-bun-node-runtime.md) for the full
finding and its consequences (`.ts`-extension imports, no parameter-property shorthand, CI needing
both runtimes).

## Risk A: `@effect/sql-pg` calling `append_events_if` — works, idiomatic tier sufficient

Tier used: **idiomatic** (`sql.unsafe(sqlText, paramsArray)` with plain JS arrays for `text[]`/
`jsonb[]` params, relying on `pg`'s own array serialization + the SQL's own `::jsonb[]` casts).
Never needed the `sql.array`/`sql.json` fallback tier or a raw `pg.Pool` escape hatch for the
append call itself. `PgClient.PgClientConfig.password` must be wrapped in `Redacted.make(...)` —
passing a plain string throws `Error: Unable to get redacted value` deep inside
`@effect/sql-pg`'s internals, not at the config boundary (an easy, non-obvious first mistake).

### Real correctness bug found — not a TS-porting issue

Under the framework's documented default (`READ_COMMITTED`), two genuinely concurrent
`appendNonCommutative`-equivalent calls racing the same condition could **both succeed** —
verified empirically at ~93-95% double-success rate under real concurrent load, against both a
raw-SQL/`pg` harness and the actual **Java `EventStoreImpl`** (19/20 races both succeeded). Fixed
on the Java side (twice); the TS client relies entirely on that fix rather than doing any
isolation-level control of its own — see
[ADR-0003](docs/adr/0003-non-commutative-append-concurrency-protection.md) for the full history
and the SQL migration-drift risk this creates.

### Effect-specific finding: commit-time failures are defects, not typed failures

A `SERIALIZABLE` write-skew conflict is detected by Postgres at **COMMIT time**, and
`@effect/sql`'s `SqlClient.withTransaction` surfaces it as an unrecoverable defect (`Die`), not a
typed `SqlError` — `Effect.catchTag("SqlError", ...)` does not see it. See
[ADR-0004](docs/adr/0004-commit-time-failures-via-cause-inspection.md) for the workaround
(`Effect.catchAllCause` + manual `Cause` inspection) and its consequences for future transactional
code paths.

## Risk B, part 1: LISTEN/NOTIFY — mostly built-in, one real library bug found

`@effect/sql-pg`'s `PgClient.listen(channel)` already implements the "dedicated non-pooled
connection" pattern Java's `PostgresNotifyWakeupSource` uses by hand, returning a
`Stream<string, SqlError>` of raw payloads — no raw `pg.Client` EventEmitter bridging needed for
the subscribe path. But `PgClient.notify()` itself is broken for non-literal payloads. See
[ADR-0005](docs/adr/0005-listen-notify-implementation.md) for the bug, the `pg_notify()` SQL
workaround, and the accepted no-reconnect-on-drop limitation.

Debounce/coalescing (`Stream.groupedWithin(Number.MAX_SAFE_INTEGER, Duration.millis(20))`) verified
to coalesce a 5-notification burst into a single dispatch with the union of types/tag-keys, mirroring
Java's `PostgresNotifyWakeupSource` batching semantics.

## Risk B, part 2: advisory-lock leader election — `sql.reserve` works well

Built on `SqlClient.reserve` (public API, not a raw `pg.Client`) combined with manual
`Scope.make()`/`Scope.extend()`/`Scope.close()` to hold the connection open across a leader's
lifetime. See [ADR-0006](docs/adr/0006-leader-election-via-sql-reserve.md) for the design and the
accepted crash-path test gap. Verified: exactly one winner across 20 concurrent-race iterations;
loser can reacquire after winner releases.

**Performance note**: the 20-iteration concurrent-race test took ~21s (~1s/iteration) — likely
connection-acquisition overhead in `sql.reserve`'s pool interaction. Not a correctness concern
(leader election isn't a hot path), but worth profiling before assuming it scales.

## `event-model.yaml` cross-repo sharing — not yet investigated

Deliberately out of scope for this Phase 0 code spike (was a separate design question in the
original plan, addressed via written recommendation, not runnable code): extract
`docs/user/examples/event-model-schema.json` into its own small versioned package/repo, consumed by
both a Java validator and a TS `ajv`-based one; fix the `CommandSpec.java`/schema drift
(`idempotency`/`noopIfDuplicate` keys undocumented in the JSON Schema, `validation` field
undocumented too) as a prerequisite before treating the schema as a stable contract. Not attempted
here — no TS YAML parsing code was written in Phase 0.

## Phase 1 — eventstore client + command executor

Status: monorepo restructured into a Bun workspace (`packages/db-migrations`, `packages/test-support`,
`packages/eventstore`, `packages/commands`), real `EventStore`/`CommandExecutor` public API built,
27/27 tests passing (12 Bun unit + 15 Node integration), clean workspace-wide typecheck.

### Effect ergonomics win: no `ConnectionScopedEventStore` needed

Java's `EventStoreImpl` needs two parallel implementations of every append/project method (pooled
vs. transaction-scoped) because Java has no ambient way to know "am I inside a transaction right
now?". Effect's `SqlClient.withTransaction` makes this ambient, so one `EventStore` implementation
handles both cases. See [ADR-0002](docs/adr/0002-single-eventstore-implementation.md) for the full
reasoning and consequences.

### Real gotchas hit while building this

- **`Layer.provide` vs `Layer.provideMerge`**: `Layer.provide(appLayer, pgLayer)` satisfies
  `appLayer`'s `SqlClient` requirement using `pgLayer`, but the *result* only exposes `appLayer`'s
  own services — `SqlClient` disappears from the output. A test that needs both the app services
  *and* raw `SqlClient` access (e.g. to call `sql.withTransaction` directly) needs
  `Layer.provideMerge`, which keeps the provided layer's services in the output too. Silent "Service
  not found: SqlClient" at runtime, not a compile error, since the missing service only surfaces
  when actually requested via `yield*`.
- **`Effect.runPromise` rejects with `FiberFailure`, not the raw error.** `assert.rejects(promise,
  ConcurrencyException)` fails even when the underlying failure genuinely is a `ConcurrencyException`,
  because the rejection value's constructor is `FiberFailureImpl` (Effect's wrapper), not the tagged
  error class. Node's `instanceof`-based `assert.rejects` check can't see through the wrapper.
  Fix: catch the expected tagged failure *inside* the Effect pipeline (`Effect.catchTag(...)`,
  turning it into a plain success value) and assert on that value directly, rather than relying on
  the rejected promise's prototype chain.
- **SQL migration drift is a real, live risk, not a hypothetical.** Phase 0's copied `V1__...sql`
  predated the Java-side advisory-lock fix; Phase 1's first DCB-race test run silently reproduced
  the *original* bug (both concurrent appends succeeding) because the migration was stale, not
  because the TS client code was wrong. No tooling currently catches this drift automatically —
  worth a checksum-comparison script or CI job once both repos are actively developed in parallel
  (this was flagged as a design risk in the original assessment; it already bit us once in practice).

### Scope decisions made (deferred, not forgotten)

- **No command-type auto-discovery.** See
  [ADR-0008](docs/adr/0008-no-command-type-auto-discovery.md) — every call site passes the handler
  explicitly (`execute(command, handler)`); a `Layer`-composed handler registry is deferred, not
  ruled out.
- **No command-level audit pre-check.** Java's `CommandExecutionOptions.commandId()` path (insert
  a command-audit row before the handler runs, short-circuit to idempotent if it already exists)
  isn't ported yet — `CommandAuditStore.storeCommand`/`storeCommandIfAbsent` exist and are tested
  (transaction_id linkage), but `CommandExecutor.execute` doesn't call them itself yet. Deliberately
  deferred, not forgotten.
- **No metrics/observability equivalents.** Java's `ApplicationEventPublisher`-based metric events
  (`CommandStartedMetric`, `ConcurrencyViolationMetric`, etc.) have no TS counterpart yet — this
  matches the original assessment's callout that this needs redesigning around `@effect/opentelemetry`
  rather than transliterating, and hasn't been attempted.

## Summary: what changed vs. the original plan

- Runtime is Bun+Node hybrid, not pure Bun (blocked on Testcontainers-node/Bun incompatibility).
- Found and fixed a real, pre-existing concurrency bug in the Java framework itself (not TS-specific) —
  bigger finding than anything about the TS port's feasibility.
- Found and worked around a real bug in `@effect/sql-pg`'s `PgClient.notify`.
- Found a real Effect/`@effect/sql` gap: commit-time failures are defects, not typed errors.
- Both major integrations (SQL client, LISTEN/NOTIFY, leader election) work with less custom code
  than the original assessment assumed — `@effect/sql-pg` is more capable than expected on the
  LISTEN/NOTIFY front specifically.

## Phase 2 — event-poller module

Status: `packages/event-poller` built (generic engine only — `crablet-views`/`outbox`/`automations`
consumers are Phase 3), 19/19 tests passing (16 Bun unit + 3 Node integration files, 33 assertions
total across the Node suite once combined with Phase 0/1's existing files), clean workspace-wide
typecheck. No new migration added — the Postgres-backed progress tracker is validated against the
already-migrated `crablet_view_progress` table (see the Phase 2 plan for the reasoning).

### The one real bug this phase produced: `Effect.fork` vs `Effect.forkDaemon`

By far the most consequential thing found in Phase 2. `EventProcessor.start()` forks three
long-lived background fibers and returns immediately — built and passed against Bun unit tests
first (where the bug was invisible, since `start()` runs inside one long-lived test program), then
failed silently in Postgres integration tests, which call `start()` the way a real application
would: as its own short-lived `runPromise` call. See
[ADR-0007](docs/adr/0007-event-poller-fiber-model.md) for the full root-cause writeup and the
`forkDaemon` fix — it's the single most consequential bug found in this phase, so the ADR keeps
the complete story rather than a summary.

Lesson for future phases: **any test that calls a `start()`-shaped API (forks fibers, returns
immediately) needs to actually exercise it as a separate, short `runPromise` call** — testing it
inline inside one giant long-lived program will not catch a `fork`-vs-`forkDaemon` mistake, because
the bug is specifically about what happens *after the forking call returns*.

### `ManagedRuntime` is required for tests with persistent forked fibers

A related, second-order gotcha: a plain `Layer.Layer<...>` gets rebuilt (a fresh connection pool!)
on every single `Effect.provide(effect, layer)` / `Effect.runPromise(...)` call. Fine for one-shot
effects. Fatal for `EventProcessor.start()` specifically: its daemon fibers keep using the `SqlClient`/
`PgClient` captured from the *one* `run()` call that built and started them, but that call's own
`Effect.provide` scope (and the pool inside it) gets torn down as soon as that call's promise
resolves — "Failed to acquire connection" errors starting immediately after. Fix: build the layer
into a `ManagedRuntime.make(layer)` once in the test file's `before()` hook, use its own
`.runPromise` for every call in the file, and `.dispose()` it in `after()`. This keeps one pool
alive for the whole file's lifetime, matching how a real long-running application would hold it.

### Confirmed, real gap: `EventStoreLive.appendCommutative` doesn't fire NOTIFY

`internal/sql.ts`'s `appendEventsIf` already accepts optional `notifyChannel`/`notifyPayload`
params, but `EventStore.ts`'s `appendConditional` never passes them — so, unlike the documented
Java behavior ("the eventstore sends NOTIFY after every append; there is no separate eventstore
flag"), the **TS port's real append path does not yet notify anyone**. This was surfaced by
`event-processor-integration.test.ts`'s wakeup test, which has to call `notify()` manually after
appending (same as Phase 0's spike did) to exercise the wakeup path at all. Not fixed here — Phase 2
is scoped to the poller engine, not eventstore append behavior — but flagged as a real, load-bearing
gap: real views/automations/outbox consumers in Phase 3 will get no LISTEN/NOTIFY wakeups at all
until `appendConditional` is wired to notify, and will silently fall back to base-interval polling
only (still correct, just not low-latency).

### Design decisions carried over from the plan

See [ADR-0007](docs/adr/0007-event-poller-fiber-model.md) for the full set: one persistent fiber
per processorId (replacing Java's one-shot self-resubmitting scheduled task), the collapsed
single shared leader-retry fiber, `acquireLeader`/`wakeupStream` injected as pre-built
`Effect`/`Stream` values to decouple the engine from concrete Postgres wiring, and the
`SqlEventFetcher`'s `pg_snapshot_xmin(...)` visibility filter.

## Phase 3 — crablet-views port + NOTIFY-wiring fix

Status: `packages/views` built (the first of the three Java consumer modules -
`crablet-views`/`crablet-outbox`/`crablet-automations` - ported; outbox and automations remain
future phases, deliberately deferred since views is the simplest: single-key progress table, no
composite processor-id, no external publisher integration). 46 Bun unit + 37 Node integration tests
passing workspace-wide, clean typecheck.

### Prerequisite fixed first: `appendConditional` now fires NOTIFY automatically

Closed the gap Phase 2 flagged: `EventStoreLive.appendConditional` (`packages/eventstore/src/
EventStore.ts`) now derives a payload from the events being appended
(`NotifyPayload.encodePayload`) and passes it through to `internal/sql.ts`'s already-existing
`appendEventsIf(..., options)` on a new fixed `EVENTS_CHANNEL = "crablet_events"` (matching Java's
`PostgresNotifyWakeupSource` default channel name). No new service dependency was needed - the
`pg_notify()` call happens server-side inside `append_events_if()` itself, already reachable
through the plain `SqlClient` `EventStoreLive` already depends on. `event-poller`'s
`event-processor-integration.test.ts` wakeup test no longer needs its own manual `notify()` call -
real usage now, not a stand-in.

### `packages/views` design notes

- **`ViewProjector` interface is non-generic in `R`** (`handle: (events) => Effect<number, E,
  never>`) - by the time a projector reaches `ViewsModule.makeViewsProcessor`, every ambient
  service it needs must already be resolved, mirroring how `EventProcessorDeps.handler` itself
  requires `R = never`. `makeTransactionalViewProjector` is the standard way to get there: it
  resolves `SqlClient` once at construction (not per-call), and passes `sql` explicitly into
  `handleEvent(event, sql)` rather than expecting ambient re-resolution - closer to Java's own
  `handleEvent(event, jdbc)` parameter-passing than to `EventStore.ts`'s ambient-transaction
  pattern, and simpler to get right.
- **`makeViewEventFetcher` reuses `event-poller`'s `makeSqlEventFetcher` as-is**, one instance per
  view (each bound to that view's own `EventSelection`), dispatching by `viewName` - zero SQL-query
  duplication, unlike Java's `internal.ViewEventFetcher` which wraps
  `EventSelectionWhereClauseBuilder` itself.
- **Verified real transactional-rollback behavior**, not just wiring: `views-integration.test.ts`
  appends two events in one batch, has the transactional projector's `handleEvent` fail (typed
  `Effect.fail`, not `Effect.die` - only typed failures flow through `EventProcessor.ts`'s
  `Effect.tapError` into `recordError`/`error_count`, a mistake initially made when writing this
  test that silently cost 10s per run waiting on a predicate that could never become true) on the
  second event, and confirms via direct SQL query that the first event's insert was rolled back
  too, in the same Postgres transaction.

### Explicitly deferred (matches the Java module's own optional features)

`sharedFetch`/`SharedFetchModuleProcessor` variant, REST/HTTP management controller (the
Postgres-backed `ViewManagementService`/`getProgressDetails` alone covers ops visibility),
`AbstractTypedViewProjector`'s automatic deserialize-to-sealed-union ergonomics.
