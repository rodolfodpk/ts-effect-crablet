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

## Phase 4 — crablet-outbox port

Status: `packages/outbox` built (the second of the three Java consumer modules; automations remain
a future phase). 61 Bun unit + 40 Node integration tests passing workspace-wide, clean typecheck.

### Real finding: `TopicPublisherPair.getLockKey()` is dead code in Java

Before designing this phase, a research pass resolved an apparent contradiction in the Java source:
`TopicPublisherPair.java` has a `getLockKey()` method whose javadoc claims each (topic, publisher)
pair gets its own independent leader-election lock, but grepping the entire `crablet-outbox` module
found exactly two call sites - the method's own definition and its own unit test. Production wiring
(`OutboxAutoConfiguration.java`) builds exactly **one** `LeaderElector` (`OUTBOX_LOCK_KEY`) shared by
one `EventProcessor` instance handling every pair - the same single-module-wide-leader model views
already uses. This meant `packages/event-poller`'s engine needed zero changes: outbox's composite
processor identity is just encoded into the `I extends string` the engine already requires
(`TopicPublisherPair.toKey`/`fromKey`, using `JSON.stringify`/`parse` rather than a `"::"`-joined
string, since the migration's CHECK constraints only bound `topic`/`publisher` *length*, not
content - a naive separator would have been silently ambiguous).

### `crablet_outbox_topic_progress` already existed, unused, since Phase 0

The composite-PK progress table (with its `leader_instance`/`leader_since`/`leader_heartbeat`
columns) was copied verbatim into `packages/db-migrations` back in Phase 0 alongside the view/
automation tables, but nothing used it until now. Its shape doesn't fit
`makePostgresProgressTracker`'s single-`idColumn` assumption (confirmed exactly what that
function's own doc comment already flagged), so this phase adds a hand-rolled
`internal/OutboxProgressTracker.ts` instead, matching Java's own `OutboxProgressTracker` (which
also implements `ProgressTracker` directly rather than reusing the single-key abstract base).

The migration's column comment describes `leader_heartbeat` as detecting "abandoned pairs when
leader crashes" - so `getLastPosition` (called every poll tick, not just when there's new work)
refreshes `leader_instance`/`leader_heartbeat` as a side effect, keeping it a real liveness signal
during idle periods too, not just on activity. No failover/reassignment logic consumes it yet -
same explicitly-scoped simplification `Leader.ts` already documents for its own crash path.

### Explicitly deferred (matches the Java module's own optional features)

`sharedFetch`/`SharedFetchModuleProcessor` variant, REST/HTTP management controller,
`StatisticsPublisher`/`GlobalStatisticsPublisher` reference implementations (`makeLogPublisher`
alone proves the `OutboxPublisher` contract out), leader-crash/failover testing (Java's
`OutboxLeaderFailoverTest`), and `TopicPublisherPair.getLockKey()` itself (confirmed dead code -
not porting unused code).

## Phase 5 — crablet-automations port

Status: `packages/automations` built (the last of the three Java consumer modules - views and
outbox already ported). 72 Bun unit tests passing workspace-wide (up from 61; 11 new: decision
constructors, processor-config override resolution, dispatcher routing/NoOp/die/ordering/
correlation-propagation), 42 Node/Testcontainers integration tests passing workspace-wide (up
from 40; 2 new, covering the full trigger→decide→CommandExecutor→resulting-event loop plus
correlation/causation propagation and a NoOp path against real Postgres), clean workspace-wide
typecheck. Same zero-migration, zero-`event-poller`-engine-changes outcome as Phases 3-4:
`crablet_automation_progress` (single
`automation_name` PK) and `AUTOMATIONS_LOCK_KEY` both already existed, unused, since earlier phases.

An automation is a process-manager/saga-style reaction: one `StoredEvent` triggers `decide()`,
which returns a list of `AutomationDecision`s (`ExecuteCommand`/`NoOp`); `ExecuteCommand` gets
dispatched through `@crablet/commands`' `CommandExecutor` - the first consumer module in this port
to depend on `@crablet/commands` at all.

### Design decision: bind the command handler once per automation, not per-decision

Java's `AutomationDispatcher` resolves the right `CommandHandler` by runtime type lookup on the
decision's `Object command`; this repo's `CommandExecutor` has no such lookup (`ADR-0008` - every
call site passes the handler explicitly). So `AutomationHandler<T, E, HE>`
(`packages/automations/src/AutomationHandler.ts`) binds one `CommandHandler<T, HE>` once, at
construction, and `AutomationDecision<T>` (`AutomationDecision.ts`) stays a plain data union with
no handler inside it - `{ _tag: "ExecuteCommand"; command: T }` or `{ _tag: "NoOp" }`. Consequence
worth remembering: one automation reacts with exactly one command type unless the caller models
`T` as a union and supplies one union-capable handler - acceptable, not a blocker, matches the
Java example (`WalletOpenedAutomation` → `SendWelcomeNotificationCommand`, 1:1) anyway. The
heterogeneous registry of automations (each with its own `T`/`E`/`HE`) is necessarily type-erased
to `AutomationHandler<any, any, any>` at the internal-wiring boundary (`internal/
AutomationEventFetcher.ts`, `internal/AutomationEventHandler.ts`, `internal/
AutomationProcessorConfig.ts`, `AutomationsModule.ts`) - same erasure Java's `Object command` does
at runtime, just confined to these four files rather than leaking into the public API.

### Real gotcha: holding the `CommandExecutor` tag value does not discharge its `R`

`makeEventProcessor` requires `handler: EventHandler<I, unknown, never>` - views/outbox satisfy
this because their handlers never need ambient services beyond what they capture once at
construction (e.g. `ViewProjector`'s captured `sql`). Automations looked like it should work the
same way by just `yield* CommandExecutor` once - but `CommandExecutorService.execute` still
returns `Effect<ExecutionResult, E | ConcurrencyException | SqlError, EventStore |
CommandAuditStore | SqlClient.SqlClient>` even when called on an already-resolved
`CommandExecutorService` value, because `CommandExecutorLive`'s own implementation does `yield*
EventStore` etc. internally whenever the *returned effect* actually runs - resolving the service
value doesn't pre-resolve what that service's methods ask for later. Fix: `AutomationsModule.ts`'s
`makeAutomationsProcessor` yields `CommandExecutor`, `EventStore`, `CommandAuditStore`, and
`SqlClient.SqlClient` once, then builds an `executeDecision` closure that pipes each call through
`Effect.provideService` for those three services before handing the resulting
`EventHandler<string, unknown, never>` to `makeEventProcessor` - the same "capture ambient deps
once, pass concrete values onward" pattern `ViewProjector.ts`'s `makeTransactionalViewProjector`
already established for `sql` alone, just across three services instead of one. No
`event-poller` changes needed either way - the adaptation lives entirely in this module's own
wiring layer (`makeAutomationsProcessor`'s required `R`: `SqlClient.SqlClient | PgClient.PgClient |
CommandExecutor | EventStore | CommandAuditStore`).

### Explicitly deferred (matches the Java module's own optional features)

`ViewBackedAutomationHandler` (optional `crablet-views`-on-classpath extension inferring wake
events from view subscriptions), `sharedFetch`/`SharedFetchModuleProcessor` variant and its two
module-level scan-progress tables, and `AutomationObservationListener`/Micrometer-based metrics
(matches the port-wide "no `ApplicationEventPublisher`-equivalent metrics yet" deferral already
recorded in Phase 1).

## Phase 6 — `@crablet/metrics-otel`: metrics vocabulary + wiring

Status: `packages/metrics-otel` built and wired into all six real call sites (eventstore, commands,
event-poller, views, outbox, automations). 78 Bun unit tests passing workspace-wide (up from 72; 6
new: `observe()`'s duration/success/failure/tagging behavior, verified directly against Effect's
own in-memory `Metric` registry, no mocking), 42 Node/Testcontainers integration tests still passing
(no regressions from the wiring - `command-executor.test.ts` and the automations test suite needed
mechanical call-site updates for the new `commandType` parameter, not behavior changes), clean
workspace-wide typecheck.

This finally addresses the "redesign, not transliteration" callout every prior phase deferred:
Java's metrics story is two parallel, Spring-specific mechanisms (a deprecated reflection-based
`MicrometerMetricsCollector`, and the current per-module Micrometer `Observation`/
`ObservationListener` path) - Effect's own `Metric` module replaces both at once, since a
`Metric.counter`/`gauge`/`histogram` value **is** simultaneously the name, the live instrument, and
the recording handle. No event-bus/registry indirection needed anywhere.

### Real gotcha: `Metric.trackDuration` does not record duration on failure

The most consequential finding this phase. `Metric.trackDuration`'s own doc comment reads as if it
always records - it doesn't. Traced into `effect@3.21.4`'s own source
(`internal/metric.js`'s `trackDurationWith`): it's built on `Effect.tap`, which by construction only
runs on the *success* channel. A first cut of `internal/observe.ts` using `Metric.trackDuration`
silently dropped every failure-path timing sample - caught by `observe.test.ts`'s own
"records a failure... still records a duration sample" test, which failed with `duration.count` at
0 instead of 1 until fixed. The fix: measure `Clock.currentTimeNanos` by hand before/after via
`Effect.exit` (converting "fail" into a plain value instead of letting it propagate early), so
duration gets recorded regardless of `Exit.isSuccess`/`Exit.isFailure` - matching what Java's
Micrometer `Observation` timer actually does. Worth remembering for any future Effect `Metric` work
in this codebase: `trackDuration`/`trackSuccess`/`trackDurationWith` are all `Effect.tap`-based,
success-path-only aspects, not "runs regardless" aspects - only `trackError`/`trackErrorWith` cover
the failure path, and there's no single built-in aspect that covers both at once.

### Design decision: two counters instead of one outcome-tagged counter

Java's Micrometer `Observation` produces ONE timer whose `outcome` tag (`success`/`failure`) is
chosen after the underlying operation finishes. Effect's `Metric.tagged` can only add a tag whose
value is known before the metric is used, not one chosen retroactively - so `internal/observe.ts`'s
`OperationMetrics` triplet (`duration`/`successes`/`failures`) uses two separate counters instead.
Equally queryable at a backend (two series instead of one tag-split series) - a deliberate
"redesign, not transliteration" call, not a capability gap.

### Breaking change: `CommandExecutor.execute` gained a `commandType` parameter

Java tags `CommandMetrics` by `command.getClass().getSimpleName()` via reflection. This port's
commands are plain objects/interfaces, not classes - there is no runtime type name to derive a tag
from. Rather than drop the tag dimension, `CommandExecutorService.execute<T, E>` gained an explicit
`commandType: string` first parameter (confirmed with the user as the preferred trade-off over
losing per-command-type metric breakdown). Rippled through `command-executor.test.ts` (6 call
sites) and, since `AutomationHandler<T, E, HE>` binds one `CommandHandler` per automation, gained
its own new `commandType: string` field threaded through `AutomationEventHandler.ts`'s
`ExecuteDecision` type and `AutomationsModule.ts`'s `executeDecision` closure, rippling through all
three automations test files. A genuinely easy mistake avoided here: several test `executeDecision`
stubs were originally written as `(command) => ...` (positional match against the *first*
parameter) - after the signature shift to `(commandType, command, handler)`, those would have
silently received the `commandType` string where `command` was expected, with no compiler error
(TypeScript matches callback parameters positionally, not by name). Fixed by renaming to
`(_commandType, command) => ...` at each affected call site.

### Wiring notes

- **`event-poller/EventProcessor.ts`** is the single highest-leverage site: `crablet.poller.*`
  cycle/backoff/leadership metrics are instrumented once in the shared engine (`tick`'s
  `Exit.isSuccess` branch, and the leader-acquisition retry loop), so views/outbox/automations all
  get this instrumentation for free - the same "one shared engine, zero per-consumer duplication"
  win ADR-0007 already established for scheduling, just for metrics this time.
- **Leadership gauge tagging**: Java's `LeadershipMetric` tags by `processorId`, but this port's
  leader election is module-wide (one `LeaderHandle` shared across every `processorId` an
  `EventProcessor` instance manages - confirmed back in Phase 4's outbox research). Tagged by
  `lock_key` (the module's fixed constant, e.g. `VIEWS_LOCK_KEY`) instead - the closest faithful
  equivalent of "which election is this," since there's no per-processorId leader to speak of.
- **`eventstore/EventStore.ts`**: all three semantic append methods
  (`appendCommutative`/`appendNonCommutative`/`appendIdempotent`) share one `appendConditional`
  primitive, so instrumentation lives there once, not tripled.

### Explicitly deferred

- **Real OTel export `Layer`** - confirmed scope decision with the user before starting: building a
  working `@effect/opentelemetry` `Metrics.layer` requires adding `@effect/platform` plus 7 separate
  `@opentelemetry/*` peer packages this repo doesn't otherwise need. Metrics recorded via Effect's
  `Metric` are always safe/cheap in-process regardless (queryable via `Metric.value`/
  `Metric.snapshot`) - matching Java's own "export is optional, app-provided" stance. Follow-up
  recipe for whoever picks this up:

  ```ts
  import { NodeSdk } from "@effect/opentelemetry";
  import { PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";
  import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http";

  const MetricsLive = NodeSdk.layer(() => ({
    resource: { serviceName: "my-crablet-app" },
    metricReader: new PeriodicExportingMetricReader({
      exporter: new OTLPMetricExporter({ url: "http://localhost:4318/v1/metrics" }),
      exportIntervalMillis: 10_000
    })
  }));
  // Provide MetricsLive alongside EventStoreLive/CommandExecutorLive/etc. at the app's composition
  // root - every Metric.counter/gauge/timer already wired into this port's packages starts
  // exporting with zero further code changes, since they're already live/ambient module-level
  // values.
  ```

- **Legacy dot-separated Micrometer-dashboard-compatible metric names** (`eventstore.events.appended`,
  etc.) - Java itself deprecates this path in favor of the Observation naming scheme this port uses
  (`crablet.eventstore.append`, etc.); not porting deprecated code.
- **Per-module `*ObservationAutoConfiguration`-style conditional registration** - Effect's `Metric`
  values are always live/ambient module-level constants; there's no Spring-style conditional-bean
  gate to port. Recording is always on; export (once built, see above) is the actual opt-in step.

## Phase 7 — `@crablet/commands-http`: generic REST command API

Status: `packages/commands-http` built - the first HTTP surface anywhere in this port. Mirrors
Java's `crablet-commands-web` (full survey done): a single generic `GET`/`POST /api/commands`
dispatcher, RFC 7807 error bodies, optional correlation-header echo/generate. 84 Bun unit tests
passing workspace-wide (up from 78; 6 new: `ExposedCommand` map construction/lookup, each
`ProblemDetail` variant's encoded JSON shape/status), 53 Node/Testcontainers integration tests
passing (up from 42; 11 new, all against a real HTTP server bound to an ephemeral port and driven
by real `fetch()` calls, real Postgres, real `CommandExecutor`), clean workspace-wide typecheck.

### Before writing any of the real package: a spike, per explicit reviewer instruction

The plan review correctly flagged three unverified assumptions about `@effect/platform`'s actual
runtime behavior - `HttpApiEndpoint.setPayload` is normally a *static* schema but this dispatcher's
payload is runtime-selected; `addSuccess(schema, {status})` fixes one status per schema but this
endpoint needs 200 *or* 201 from the same handler; `Schema.TaggedError`'s encoded JSON shape was
unverified against RFC 7807. Spiked against a real running server (`bun add`, wrote a throwaway
single-endpoint `HttpApi`, drove it with `curl`) before writing any package code, and all three
resolved concretely:

1. **Static envelope payload works.** `Schema.Struct({ commandType: Schema.String, command:
   Schema.Unknown })` decodes fine as `setPayload`'s argument; all "which concrete command is
   this" polymorphism happens inside the handler body via a *second* `Schema.decodeUnknown` call
   against the app-supplied per-command schema - exactly mirroring Java's controller manually
   calling `objectMapper.treeToValue(node, commandClass)` *after* resolving `commandType`.
2. **Dynamic 200/201 works** by returning a raw `HttpServerResponse.json(body, {status})` directly
   from the handler, bypassing `addSuccess` entirely (no `addSuccess` is even declared for the
   POST endpoint in the real package - see `CommandApi.ts`).
3. **`Schema.TaggedError` leaks `_tag` into the JSON body**, with no automatic `type`/`title`
   fields - confirmed the reviewer's concern exactly. Fix, also verified by running it: use plain
   (non-tagged) `Schema.Class` for the wire-level error shape instead. `HttpApiSchema.
   annotations({status})` still works correctly for the real HTTP status line either way -
   status-code control and body-shape control turned out to be two independent mechanisms.

This is the first phase in the port that ran an empirical framework spike *before* committing to
an implementation plan, per explicit reviewer instruction - worth repeating for any future phase
introducing a new, previously-unused Effect ecosystem package (this port had never touched
`@effect/platform` before this phase).

### Design decision: app-supplied flat command map replaces Java's two-tier reflection registry

Java resolves `commandType` (JSON string) to a concrete command class via
`DiscoveredCommandRegistry` (reflecting over every `CommandHandler` bean's generic parameter +
Jackson `@JsonSubTypes` annotations) filtered through an app-supplied `CommandApiExposedCommands`
allowlist. This port has no auto-discovery anywhere (`ADR-0008`) and commands are plain objects,
not annotated classes - so both Java tiers collapse into one flat, app-supplied map:
`ExposedCommand.ts`'s `Record<string, { schema, handler }>`. Consequence: there's no Java-style
"known but not exposed" 404 case - anything not in the map is simply unknown (400), collapsing two
distinct Java failure modes into one.

### Design decision: the package never chooses Bun vs. Node as the server runtime

`@crablet/commands-http` depends only on `@effect/platform` (`HttpApi`/`HttpApiBuilder`/`Schema` -
server-runtime-agnostic) as a real dependency; `@effect/platform-node` is a **devDependency only**,
used solely by this package's own integration test (which, per `ADR-0001`, must run under Node for
Testcontainers). A real production app is free to use `@effect/platform-bun`'s `BunHttpServer`
instead, or Node's, without this package caring either way - same "capture ambient deps, let the
caller wire concrete infrastructure" pattern `EventStoreLive`/`CommandExecutorLive` already use for
`SqlClient`/`PgClient`. Confirmed empirically that `@effect/platform-node`'s heavier peer
dependencies (`@effect/rpc`, `@effect/cluster`) install cleanly via `bun install` with no warnings
or failures, even though this package only uses basic HTTP serving.

### Real finding: malformed JSON never reaches the handler at all

`@effect/platform`'s own payload-schema-decode failure returns a 400 *before*
`CommandApiLive.ts`'s handler runs - confirmed empirically (a standalone script sending
`"{not valid json"` against a real running server returned status 400 with an **empty body**, not
this port's RFC 7807 shape). A `CommandApiMalformedJson` ProblemDetail variant was written and
tested first, then deleted once this became clear - genuinely unreachable code, since nothing in
this port's handler ever constructs it. Reshaping the framework's own default decode-failure
response into the RFC 7807 shape is a documented, deliberate gap (not attempted here), not a bug -
`ProblemDetail.ts` explains this in its own doc comment for the next person who touches this file.

### Error-mapping precedence in `CommandApiLive.ts`

`ConcurrencyException` (needs its real `DCBViolation` detail - violationCode/matchingEventsCount -
preserved) is caught first, mapped to `CommandConflict` (409). Everything else reaching the
handler's outer boundary - `SqlError` (genuine infra failure), the command handler's own
app-defined validation error `E`, any framework-internal decode/encode error - gets normalized by
one terminal `toProblemDetail` catch-all to `CommandApiUnexpectedError` (500) unless it's already
one of the three known `ProblemDetail` types, in which case it passes through unchanged. This
mirrors Java's literal "catch-all `Exception` → 500, message not echoed" safety net, and avoids
the fragile alternative (enumerating every possible framework-internal error type by hand at each
call site) that briefly produced hard-to-satisfy TypeScript inference errors through the
type-erased `ExposedCommand<any, any>` boundary before being simplified to this shape.

### Correlation header, precisely

Matches Java's own precise (if implicit) behavior, made explicit here: disabled → ignore any
inbound `X-Correlation-Id` entirely; enabled + header present → validate as a UUID (`Schema.UUID`,
400 on malformed) and echo the same value back; enabled + header absent → generate a new UUID and
echo it. Only the `CommandExecutor.execute` call itself runs inside
`CorrelationContext.withCorrelationId(...)` - request parsing/validation (commandType lookup,
payload decode, header validation) deliberately does not, so a 400 from bad input never gets a
correlation id wrapped around it. The echo header is only guaranteed on success responses in this
first cut - `HttpApiBuilder`'s own error-response encoding path doesn't give the handler an
obvious hook to attach a header to a framework-constructed error response; documented as a known,
minor scope limitation rather than chased further.

### Explicitly deferred (matches Java's own "optional" framing)

- **springdoc/OpenAPI `oneOf` discriminator wiring** - `@effect/platform`'s `HttpApiSwagger` could
  generate basic OpenAPI docs for free from the `HttpApi` definition; not built here, cheap
  follow-up if ever needed.
- **Virtual-thread dispatch test** (Java's `CommandApiVirtualThreadE2ETest`) - no Node/Bun
  analogue.
- **Package-prefix-based exposure** (Java's `CommandApiExposedCommands.fromPackages(...)`) - no
  meaning without reflection/classpath scanning; the flat map already IS the exposure list.
- **Malformed-JSON RFC 7807 reshaping** - see the finding above.
