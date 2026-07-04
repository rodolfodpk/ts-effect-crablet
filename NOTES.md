# Phase 0 Spike — Findings

Status: all acceptance criteria from the plan (`/Users/rodolfo/Documents/ts-effect-crablet-phase0-plan.md`)
met except where noted. 22/22 tests passing (12 under Bun, 10 under Node).

## Runtime: Bun + Node hybrid, not Bun-only

Bun (1.3.11) is the package manager and runtime for pure-function tests (`bun test`,
`test/notify-payload.test.ts`). **`@testcontainers/postgresql` hangs indefinitely under Bun** —
the underlying Docker container starts and becomes healthy (confirmed via `docker ps`), but the
JS-side wait-strategy that confirms readiness never returns. The identical script completes in
1.83s under plain Node 25. Root cause not investigated further (likely Bun's Node-compat layer vs.
testcontainers-node's log-stream-following internals) — this is a known, reproducible blocker, not
a config mistake.

**Consequence**: all Testcontainers-dependent tests (`append.test.ts`, `leader-election.test.ts`,
`listen-notify.test.ts`) run via `node --test`, using Node's built-in test runner (not Vitest —
kept dependencies minimal for the spike). Relative imports use `.ts` extensions directly (not the
usual `.js`-in-source convention), since there's no build step — both Bun and Node resolve `.ts`
extensions directly when running un-transpiled. TypeScript files avoid constructor
parameter-property shorthand (`constructor(readonly x: T)`) — that syntax needs real
transformation, not mere type-stripping, and breaks Node's native TS execution.

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
raw-SQL/`pg` harness and the actual **Java `EventStoreImpl`** (19/20 races both succeeded).
`append_events_if()`'s conflict check is snapshot-based
(`transaction_id < pg_snapshot_xmin(...)`), which can't see a peer transaction's row until that
peer commits — a real gap between the framework's documented guarantee
(`DCB_AND_CRABLET.md`: "Protection Mechanism: PostgreSQL snapshot isolation (MVCC)") and actual
behavior for genuinely-simultaneous (not staggered) races.

**Fixed on the Java side, twice.** First pass (commit `f082973f`): `appendIf` bumped to
`SERIALIZABLE` isolation when a concurrency condition was present, mapping the resulting SQLSTATE
`40001` to `ConcurrencyException` (~10% latency overhead). **Superseded** (commit `b11118b8`):
that fix only covered the standalone `appendIf` path — `CommandExecutorImpl` (the real,
command-handler-driven path almost all usage goes through) calls a *different* method,
`appendIfWithConnection`, which Postgres's "isolation level must be set before any query runs in
the transaction" rule made impossible to patch the same way. The actual fix moved the protection
into `append_events_if()` itself: a second, distinctly-namespaced `pg_advisory_xact_lock` (mirroring
the existing idempotency lock) serializes the concurrency check at the SQL layer, working
uniformly regardless of caller isolation level, at lower overhead (~4.7% vs ~10%). **This repo's
`sql.ts` (Phase 1) reflects the current (lock-based) fix** — no isolation-level games needed on the
TS side either; see Phase 1 notes below. The SQL migrations in `packages/db-migrations/sql/` must
be kept in sync with `spring-crablet`'s `crablet-db-migrations` — they drifted once already this
session (Phase 0's copy predated the lock fix), causing a silent regression until re-synced.

### Effect-specific finding: commit-time failures are defects, not typed failures

A `SERIALIZABLE` write-skew conflict is detected by Postgres at **COMMIT time** (error detail:
"Canceled on identification as a pivot, during commit attempt"). `@effect/sql`'s
`SqlClient.withTransaction` surfaces a commit-time failure as an **unrecoverable defect** (`Die`),
not a typed `SqlError` in the `E` channel — `Effect.catchTag("SqlError", ...)` does **not** see
it. Had to use `Effect.catchAllCause` and walk the `Cause` structure manually
(`Die.defect.cause.code`) to catch it regardless of whether it arrives as a `Fail` or a `Die`. This
is a real, non-obvious Effect/`@effect/sql` ergonomics gap worth knowing before designing the real
port's error-handling conventions.

## Risk B, part 1: LISTEN/NOTIFY — mostly built-in, one real library bug found

**Major positive finding**: `@effect/sql-pg`'s `PgClient.listen(channel)` already implements the
"dedicated non-pooled connection" pattern Java's `PostgresNotifyWakeupSource` uses by hand — a
ref-counted (`RcRef`) `new Pg.Client(pool.options)` separate from the pool
(`node_modules/@effect/sql-pg/dist/esm/PgClient.js:215-231`), returning a
`Stream<string, SqlError>` of raw payloads. **No raw `pg.Client` EventEmitter bridging was needed**
for the subscribe path — this contradicts the original HTML assessment's assumption that
`@effect/sql-pg` "likely doesn't wrap LISTEN/NOTIFY."

**Caveat**: `PgClient`'s internal `onListenClientError` handler is a no-op — there is no automatic
reconnect-with-backoff on connection drop, unlike Java's explicit exponential backoff
(`1000 << attempt`, capped 60000ms, resetting after success). A production port would need to wrap
`.listen()`'s stream in retry/reconnect logic; the current primitive doesn't provide it.

**Real bug found**: `PgClient.notify(channel, payload)` (v0.52.1) is broken for any non-literal
payload — it runs `NOTIFY <channel>, $1` with the payload as a bind parameter
(`PgClient.js:262-274`), but Postgres's `NOTIFY` command syntax only accepts a string *literal* for
the payload, not a parameter placeholder. Confirmed directly against Postgres:
`NOTIFY test_channel, $1` → `syntax error at or near "$1"` (SQLSTATE `42601`). The `pg_notify()`
*function* form (used by `append_events_if()` itself) accepts a parameter correctly. Worked around
in `src/listen.ts` (`notify` export uses ``pg`SELECT pg_notify(${channel}, ${payload})` `` instead
of `pg.notify`) — this is the one to use, not the library's own helper, until/unless upstream fixes
it.

Debounce/coalescing (`Stream.groupedWithin(Number.MAX_SAFE_INTEGER, Duration.millis(20))`) verified
to coalesce a 5-notification burst into a single dispatch with the union of types/tag-keys, mirroring
Java's `PostgresNotifyWakeupSource` batching semantics.

## Risk B, part 2: advisory-lock leader election — `sql.reserve` works well

Built on `SqlClient.reserve: Effect<Connection, SqlError, Scope>` (public API, not a raw `pg.Client`)
combined with manual `Scope.make()`/`Scope.extend()`/`Scope.close()` to hold the connection open on
success (mirroring Java's "never return to pool until released" pattern) and close it immediately
on failure. `pg_try_advisory_lock`/`pg_advisory_unlock` via `Connection.execute(...)`. Verified:
exactly one winner across 20 concurrent-race iterations; loser can reacquire after winner releases.

**Known simplification**: did not simulate a true crash (killing the connection without running
`pg_advisory_unlock`) — `leader.ts` doesn't expose raw connection access for that, and building it
felt like scope creep for Phase 0. Only the graceful release path is tested here. A true crash-path
test (relying on Postgres's own connection-drop cleanup) is a good Phase 1 addition.

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

Java's `EventStoreImpl` needs two parallel implementations of every append/project method — one
using a fresh pooled connection (`appendIf`), one using an already-open transaction-scoped
connection (`appendIfWithConnection`, wrapped by the inner `ConnectionScopedEventStore` class) —
because Java has no ambient way to know "am I inside a transaction right now?" without explicit
plumbing. Effect's `SqlClient.withTransaction` makes this ambient: whatever `SqlClient` is in the
current Effect context is already transaction-scoped inside a `withTransaction` block, and
un-scoped outside it. **One `EventStore` implementation handles both cases** — no dual-class
design needed. Same story for `CommandHandler`: Java's `handle(EventStore eventStore, T command)`
takes the store explicitly because there's no ambient context; the TS `CommandHandler<T> = (command:
T) => Effect<CommandDecision, E, EventStore>` gets `EventStore` from Effect's context automatically
(`yield* EventStore` inside the handler), so the signature only needs the command.

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

- **No command-type auto-discovery.** Java's `CommandExecutor.execute(command)` (single-arg)
  reflects on a JSON `commandType` property to find the registered handler. TS has no equivalent
  runtime reflection without extra machinery (a `Map` keyed by some discriminant); every call site
  in this port passes the handler explicitly (`execute(command, handler)` only). A
  `Layer`-composed handler registry (per the original HTML assessment's suggestion) is a reasonable
  Phase 2+ addition if ergonomics demand it.
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
