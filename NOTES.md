# Phase 0 Spike — Findings

Status: all acceptance criteria from the plan (`/Users/rodolfo/Documents/ts-effect-crablet-phase0-plan.md`)
met except where noted. 22/22 tests passing (12 under Bun, 10 under Node).

**Architectural decisions** made across all phases now live in [`docs/adr/`](docs/adr/README.md),
one file per decision. This file stays the phase-by-phase journal: status, gotchas, bugs found,
and what changed vs. each phase's plan. Early entries (Phase 0 - 3) refer to the predecessor
the framework started from; that is historical. Nothing in the code or API follows it any more (ADR-0010).

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
raw-SQL/`pg` harness and the actual **predecessor `EventStoreImpl`** (19/20 races both succeeded). Fixed
in the SQL (twice); the TS client relies entirely on that fix rather than doing any
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
connection" pattern the predecessor's `PostgresNotifyWakeupSource` uses by hand, returning a
`Stream<string, SqlError>` of raw payloads — no raw `pg.Client` EventEmitter bridging needed for
the subscribe path. But `PgClient.notify()` itself is broken for non-literal payloads. See
[ADR-0005](docs/adr/0005-listen-notify-implementation.md) for the bug, the `pg_notify()` SQL
workaround, and the accepted no-reconnect-on-drop limitation.

Debounce/coalescing (`Stream.groupedWithin(Number.MAX_SAFE_INTEGER, Duration.millis(20))`) verified
to coalesce a 5-notification burst into a single dispatch with the union of types/tag-keys, mirroring
The predecessor's `PostgresNotifyWakeupSource` batching semantics.

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
both a validator in the predecessor and a TS `ajv`-based one; fix the `CommandSpec`/schema drift
(`idempotency`/`noopIfDuplicate` keys undocumented in the JSON Schema, `validation` field
undocumented too) as a prerequisite before treating the schema as a stable contract. Not attempted
here — no TS YAML parsing code was written in Phase 0.

## Phase 1 — eventstore client + command executor

Status: monorepo restructured into a Bun workspace (`packages/db-migrations`, `packages/test-support`,
`packages/eventstore`, `packages/commands`), real `EventStore`/`CommandExecutor` public API built,
27/27 tests passing (12 Bun unit + 15 Node integration), clean workspace-wide typecheck.

### Effect ergonomics win: no `ConnectionScopedEventStore` needed

The predecessor's `EventStoreImpl` needs two parallel implementations of every append/project method (pooled
vs. transaction-scoped) because the predecessor has no ambient way to know "am I inside a transaction right
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
  predated the predecessor-side advisory-lock fix; Phase 1's first DCB-race test run silently reproduced
  the *original* bug (both concurrent appends succeeding) because the migration was stale, not
  because the TS client code was wrong. No tooling currently catches this drift automatically —
  worth a checksum-comparison script or CI job once both repos are actively developed in parallel
  (this was flagged as a design risk in the original assessment; it already bit us once in practice).

### Scope decisions made (deferred, not forgotten)

- **No command-type auto-discovery.** See
  [ADR-0008](docs/adr/0008-no-command-type-auto-discovery.md) — every call site passes the handler
  explicitly (`execute(command, handler)`); a `Layer`-composed handler registry is deferred, not
  ruled out.
- **No command-level audit pre-check.** The predecessor's `CommandExecutionOptions.commandId()` path (insert
  a command-audit row before the handler runs, short-circuit to idempotent if it already exists)
  isn't ported yet — `CommandAuditStore.storeCommand`/`storeCommandIfAbsent` exist and are tested
  (transaction_id linkage), but `CommandExecutor.execute` doesn't call them itself yet. Deliberately
  deferred, not forgotten.
- **No metrics/observability equivalents.** The predecessor's `ApplicationEventPublisher`-based metric events
  (`CommandStartedMetric`, `ConcurrencyViolationMetric`, etc.) have no TS counterpart yet — this
  matches the original assessment's callout that this needs redesigning around `@effect/opentelemetry`
  rather than transliterating, and hasn't been attempted.

## Summary: what changed vs. the original plan

- Runtime is Bun+Node hybrid, not pure Bun (blocked on Testcontainers-node/Bun incompatibility).
- Found and fixed a real, pre-existing concurrency bug in the predecessor framework itself (not TS-specific) —
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
The predecessor behavior ("the eventstore sends NOTIFY after every append; there is no separate eventstore
flag"), the **TS port's real append path does not yet notify anyone**. This was surfaced by
`event-processor-integration.test.ts`'s wakeup test, which has to call `notify()` manually after
appending (same as Phase 0's spike did) to exercise the wakeup path at all. Not fixed here — Phase 2
is scoped to the poller engine, not eventstore append behavior — but flagged as a real, load-bearing
gap: real views/automations/outbox consumers in Phase 3 will get no LISTEN/NOTIFY wakeups at all
until `appendConditional` is wired to notify, and will silently fall back to base-interval polling
only (still correct, just not low-latency).

### Design decisions carried over from the plan

See [ADR-0007](docs/adr/0007-event-poller-fiber-model.md) for the full set: one persistent fiber
per processorId (replacing the predecessor's one-shot self-resubmitting scheduled task), the collapsed
single shared leader-retry fiber, `acquireLeader`/`wakeupStream` injected as pre-built
`Effect`/`Stream` values to decouple the engine from concrete Postgres wiring, and the
`SqlEventFetcher`'s `pg_snapshot_xmin(...)` visibility filter.

## Phase 3 — crablet-views port + NOTIFY-wiring fix

Status: `packages/views` built (the first of the three predecessor consumer modules -
`crablet-views`/`crablet-outbox`/`crablet-automations` - ported; outbox and automations remain
future phases, deliberately deferred since views is the simplest: single-key progress table, no
composite processor-id, no external publisher integration). 46 Bun unit + 37 Node integration tests
passing workspace-wide, clean typecheck.

### Prerequisite fixed first: `appendConditional` now fires NOTIFY automatically

Closed the gap Phase 2 flagged: `EventStoreLive.appendConditional` (`packages/eventstore/src/
EventStore.ts`) now derives a payload from the events being appended
(`NotifyPayload.encodePayload`) and passes it through to `internal/sql.ts`'s already-existing
`appendEventsIf(..., options)` on a new fixed `EVENTS_CHANNEL = "crablet_events"` (matching the predecessor's
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
  `handleEvent(event, sql)` rather than expecting ambient re-resolution - closer to the predecessor's own
  `handleEvent(event, sql)` parameter-passing than to `EventStore.ts`'s ambient-transaction
  pattern, and simpler to get right.
- **`makeViewEventFetcher` reuses `event-poller`'s `makeSqlEventFetcher` as-is**, one instance per
  view (each bound to that view's own `EventSelection`), dispatching by `viewName` - zero SQL-query
  duplication, unlike the predecessor's `internal.ViewEventFetcher` which wraps
  `EventSelectionWhereClauseBuilder` itself.
- **Verified real transactional-rollback behavior**, not just wiring: `views-integration.test.ts`
  appends two events in one batch, has the transactional projector's `handleEvent` fail (typed
  `Effect.fail`, not `Effect.die` - only typed failures flow through `EventProcessor.ts`'s
  `Effect.tapError` into `recordError`/`error_count`, a mistake initially made when writing this
  test that silently cost 10s per run waiting on a predicate that could never become true) on the
  second event, and confirms via direct SQL query that the first event's insert was rolled back
  too, in the same Postgres transaction.

### Explicitly deferred (matches the predecessor module's own optional features)

`sharedFetch`/`SharedFetchModuleProcessor` variant, REST/HTTP management controller (the
Postgres-backed `ViewManagementService`/`getProgressDetails` alone covers ops visibility),
`AbstractTypedViewProjector`'s automatic deserialize-to-sealed-union ergonomics.

## Phase 4 — crablet-outbox port

Status: `packages/outbox` built (the second of the three predecessor consumer modules; automations remain
a future phase). 61 Bun unit + 40 Node integration tests passing workspace-wide, clean typecheck.

### Real finding: `TopicPublisherPair.getLockKey()` is dead code in the predecessor

Before designing this phase, a research pass resolved an apparent contradiction in the predecessor source:
`TopicPublisherPair` has a `getLockKey()` method whose doc comment claims each (topic, publisher)
pair gets its own independent leader-election lock, but grepping the entire `crablet-outbox` module
found exactly two call sites - the method's own definition and its own unit test. Production wiring
(`OutboxAutoConfiguration`) builds exactly **one** `LeaderElector` (`OUTBOX_LOCK_KEY`) shared by
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
`internal/OutboxProgressTracker.ts` instead, matching the predecessor's own `OutboxProgressTracker` (which
also implements `ProgressTracker` directly rather than reusing the single-key abstract base).

The migration's column comment describes `leader_heartbeat` as detecting "abandoned pairs when
leader crashes" - so `getLastPosition` (called every poll tick, not just when there's new work)
refreshes `leader_instance`/`leader_heartbeat` as a side effect, keeping it a real liveness signal
during idle periods too, not just on activity. No failover/reassignment logic consumes it yet -
same explicitly-scoped simplification `Leader.ts` already documents for its own crash path.

### Explicitly deferred (matches the predecessor module's own optional features)

`sharedFetch`/`SharedFetchModuleProcessor` variant, REST/HTTP management controller,
`StatisticsPublisher`/`GlobalStatisticsPublisher` reference implementations (`makeLogPublisher`
alone proves the `OutboxPublisher` contract out), leader-crash/failover testing (the predecessor's
`OutboxLeaderFailoverTest`), and `TopicPublisherPair.getLockKey()` itself (confirmed dead code -
not porting unused code).

## Phase 5 — crablet-automations port

Status: `packages/automations` built (the last of the three predecessor consumer modules - views and
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

The predecessor's `AutomationDispatcher` resolves the right `CommandHandler` by runtime type lookup on the
decision's `Object command`; this repo's `CommandExecutor` has no such lookup (`ADR-0008` - every
call site passes the handler explicitly). So `AutomationHandler<T, E, HE>`
(`packages/automations/src/AutomationHandler.ts`) binds one `CommandHandler<T, HE>` once, at
construction, and `AutomationDecision<T>` (`AutomationDecision.ts`) stays a plain data union with
no handler inside it - `{ _tag: "ExecuteCommand"; command: T }` or `{ _tag: "NoOp" }`. Consequence
worth remembering: one automation reacts with exactly one command type unless the caller models
`T` as a union and supplies one union-capable handler - acceptable, not a blocker, matches the
The predecessor example (`WalletOpenedAutomation` → `SendWelcomeNotificationCommand`, 1:1) anyway. The
heterogeneous registry of automations (each with its own `T`/`E`/`HE`) is necessarily type-erased
to `AutomationHandler<any, any, any>` at the internal-wiring boundary (`internal/
AutomationEventFetcher.ts`, `internal/AutomationEventHandler.ts`, `internal/
AutomationProcessorConfig.ts`, `AutomationsModule.ts`) - same erasure the predecessor's `Object command` does
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

### Explicitly deferred (matches the predecessor module's own optional features)

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
The predecessor's metrics story is two parallel, Spring-specific mechanisms (a deprecated reflection-based
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
duration gets recorded regardless of `Exit.isSuccess`/`Exit.isFailure` - matching what the predecessor's
Micrometer `Observation` timer actually does. Worth remembering for any future Effect `Metric` work
in this codebase: `trackDuration`/`trackSuccess`/`trackDurationWith` are all `Effect.tap`-based,
success-path-only aspects, not "runs regardless" aspects - only `trackError`/`trackErrorWith` cover
the failure path, and there's no single built-in aspect that covers both at once.

### Design decision: two counters instead of one outcome-tagged counter

The predecessor's Micrometer `Observation` produces ONE timer whose `outcome` tag (`success`/`failure`) is
chosen after the underlying operation finishes. Effect's `Metric.tagged` can only add a tag whose
value is known before the metric is used, not one chosen retroactively - so `internal/observe.ts`'s
`OperationMetrics` triplet (`duration`/`successes`/`failures`) uses two separate counters instead.
Equally queryable at a backend (two series instead of one tag-split series) - a deliberate
"redesign, not transliteration" call, not a capability gap.

### Breaking change: `CommandExecutor.execute` gained a `commandType` parameter

The predecessor tags `CommandMetrics` by `command.getClass().getSimpleName()` via reflection. This port's
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
- **Leadership gauge tagging**: the predecessor's `LeadershipMetric` tags by `processorId`, but this port's
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
  `Metric.snapshot`) - matching the predecessor's own "export is optional, app-provided" stance. Follow-up
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
  etc.) - the predecessor itself deprecates this path in favor of the Observation naming scheme this port uses
  (`crablet.eventstore.append`, etc.); not porting deprecated code.
- **Per-module `*ObservationAutoConfiguration`-style conditional registration** - Effect's `Metric`
  values are always live/ambient module-level constants; there's no Spring-style conditional-bean
  gate to port. Recording is always on; export (once built, see above) is the actual opt-in step.

## Phase 7 — `@crablet/commands-http`: generic REST command API

Status: `packages/commands-http` built - the first HTTP surface anywhere in this port. Mirrors
The predecessor's `crablet-commands-web` (full survey done): a single generic `GET`/`POST /api/commands`
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
   against the app-supplied per-command schema - exactly mirroring the predecessor's controller manually
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

### Design decision: app-supplied flat command map replaces the predecessor's two-tier reflection registry

The predecessor resolves `commandType` (JSON string) to a concrete command class via
`DiscoveredCommandRegistry` (reflecting over every `CommandHandler` bean's generic parameter +
Jackson `@JsonSubTypes` annotations) filtered through an app-supplied `CommandApiExposedCommands`
allowlist. This port has no auto-discovery anywhere (`ADR-0008`) and commands are plain objects,
not annotated classes - so both predecessor tiers collapse into one flat, app-supplied map:
`ExposedCommand.ts`'s `Record<string, { schema, handler }>`. Consequence: there's no conventional
"known but not exposed" 404 case - anything not in the map is simply unknown (400), collapsing two
distinct predecessor failure modes into one.

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
mirrors the predecessor's literal "catch-all `Exception` → 500, message not echoed" safety net, and avoids
the fragile alternative (enumerating every possible framework-internal error type by hand at each
call site) that briefly produced hard-to-satisfy TypeScript inference errors through the
type-erased `ExposedCommand<any, any>` boundary before being simplified to this shape.

### Correlation header, precisely

Matches the predecessor's own precise (if implicit) behavior, made explicit here: disabled → ignore any
inbound `X-Correlation-Id` entirely; enabled + header present → validate as a UUID (`Schema.UUID`,
400 on malformed) and echo the same value back; enabled + header absent → generate a new UUID and
echo it. Only the `CommandExecutor.execute` call itself runs inside
`CorrelationContext.withCorrelationId(...)` - request parsing/validation (commandType lookup,
payload decode, header validation) deliberately does not, so a 400 from bad input never gets a
correlation id wrapped around it. The echo header is only guaranteed on success responses in this
first cut - `HttpApiBuilder`'s own error-response encoding path doesn't give the handler an
obvious hook to attach a header to a framework-constructed error response; documented as a known,
minor scope limitation rather than chased further.

### Explicitly deferred (matches the predecessor's own "optional" framing)

- **springdoc/OpenAPI `oneOf` discriminator wiring** - `@effect/platform`'s `HttpApiSwagger` could
  generate basic OpenAPI docs for free from the `HttpApi` definition; not built here, cheap
  follow-up if ever needed.
- **Virtual-thread dispatch test** (the predecessor's `CommandApiVirtualThreadE2ETest`) - no Node/Bun
  analogue.
- **Package-prefix-based exposure** (the predecessor's `CommandApiExposedCommands.fromPackages(...)`) - no
  meaning without reflection/classpath scanning; the flat map already IS the exposure list.
- **Malformed-JSON RFC 7807 reshaping** - see the finding above.

## Phase 8 — `examples/wallet-example-app`: the first real end-to-end TS application

Status: `examples/wallet-example-app` built - the first application anywhere in this port that
composes every previously-built package (`eventstore`, `commands`, `event-poller`, `views`,
`outbox`, `automations`, `commands-http`) into one real running program, proving the whole port
actually works together rather than just passing each package's own isolated test suite. Ports
The predecessor's `wallet-example-app` (its own README frames it as "the recommended learning entry point for
Crablet") at "core walkthrough" scope: all 5 commands, 7 events, the period/"closing the books"
statement logic, all 4 views, the one automation, a log-only outbox publisher, `commands-http`
writes composed with a small hand-written read API. 27 new tests passing (15 Postgres-backed
domain/view unit tests + 12 E2E tests across 5 files, all driven through a real `NodeHttpServer` on
an ephemeral port with real `fetch()`), zero regressions to the 84 Bun unit + 53 Node integration
tests from Phases 0-7, clean workspace-wide typecheck (after adding `examples/*` to both root
`package.json` workspaces and `tsconfig.json`'s `include`).

### Small prerequisite: `@crablet/commands-http` composability refactor

The predecessor serves generic command writes and hand-written wallet reads from one port; `@effect/platform`'s
`HttpApi.Api` is a single `Context.Tag`, so two independent top-level `HttpApi.make(...)` instances
can't both be served from one `HttpApiBuilder.serve()` layer. Split `commands-http` into three
layers instead of the original two: `makeCommandApiGroup(basePath, extraErrors?)` returns just the
`HttpApiGroup` (composable into a bigger app-owned `HttpApi`); `makeCommandApiGroupLive(api,
commands, config)` takes the full composed `api` as a parameter instead of building it internally;
`makeCommandApiLive(commands, config)` (existing export, existing tests, unchanged behavior) becomes
a one-line wrapper over both. Also added `ExposedCommand.mapError` (an optional per-command hook,
tried before the generic `toProblemDetail` catch-all) and `extraErrors` on `makeCommandApiGroup` (so
an app's own RFC 7807 types get `.addError`'d and properly encoded) - without these, wallet handler
errors (`WalletNotFound`, `InsufficientFunds`) would all become generic 500s, making the
error-mapping E2E goals unreachable. Ran `commands-http`'s existing full suite after this refactor,
before touching the wallet app itself - zero behavior change confirmed.

### Two predecessor discrepancies found during research - resolved, not silently ported

1. The predecessor's `WalletBalanceViewProjector`/`WalletSummaryViewProjector` handle `WalletClosed` in their
   `switch`, but their `ViewSubscription`s never list `WalletClosed` in `eventTypes` - the
   delete-on-close branch is dead code. This port's subscriptions **do** include `WalletClosed`,
   making delete-on-close real.
2. The predecessor's `SendWelcomeNotificationCommandHandler` isn't in `WalletApplication`'s production
   `scanBasePackages` (only picked up via a broader test-only component scan) - a latent
   package-scan wiring bug. This port has no component scanning anywhere (`ADR-0008`) - every
   handler is wired explicitly, so the gap cannot occur.

### Real bug found via testing, not review: `wallet_transaction_view`'s FK race

`other-views.test.ts` initially failed with a genuine FK-violation `SqlError`: the transaction
view's projector could run before the balance view's row for the same wallet existed, because both
views are independent async projections with no ordering guarantee between them. The predecessor's own V103
migration already fixed this exact race for the summary view (dropping its FK to the balance view)
but left the transaction view's FK in place - this port's V101 migration drops it too, closing the
gap the predecessor left open, not reproducing it.

### The one real bug this phase produced: background processors never stopped, so tests hung forever

By far the most consequential thing found in this phase - the same class of bug as Phase 2's
`Effect.fork` vs `Effect.forkDaemon` lesson (see `ADR-0007`), but one level up, at the composition
root. `EventProcessorHandle.service.start` forks its daemon fibers via `forkDaemon`, deliberately
detached from any scope - by design, since they must outlive the short-lived `Effect.gen` block that
calls `start`. Closing a `Scope` or calling `ManagedRuntime.dispose()` does **not** interrupt them;
only the handle's own `.service.stop` (`Fiber.interruptAll` over the fibers it tracked) does.
`startWalletAppForTest.ts`'s first draft called `startBackgroundProcessors()` but never captured or
stopped the three returned handles - every E2E test file ran its assertions successfully, then hung
indefinitely in its `after()` hook: the still-running poll loops kept retrying against the pool torn
down by `Scope.close`/`runtime.dispose()`, logging "Failed to acquire connection" every ~100ms
forever, with `node --test` never exiting (three killed background shell runs and one direct 6+
minute hang, all silent/near-zero-CPU rather than an obvious crash, made this hard to distinguish
from a genuine Testcontainers/Docker problem until traced with a minimal step-by-step diagnostic
script). Fixed by having `startBackgroundProcessors` return the three `EventProcessorHandle`s
(new `BackgroundProcessors` interface + `stopBackgroundProcessors` helper in `WalletApp.ts`), and
`startWalletAppForTest`'s `stop()` now calls `stopBackgroundProcessors` before `Scope.close`.
Lesson for any future composition root that aggregates multiple `start()`-shaped processors: the
"stop everything" path must explicitly enumerate and stop each one - there is no automatic
propagation from closing the outer scope, no matter how many layers of `Scope`/`ManagedRuntime` wrap
around it.

### Explicitly deferred (matches the confirmed "core walkthrough" scope, not full predecessor app parity)

- **`WalletWebhookPublisher`** (Resilience4j circuit-breaker HTTP publisher) - a second, more
  elaborate `OutboxPublisher` example; the log publisher already proves the interface out, same
  reasoning Phase 4 used for the predecessor's own `StatisticsPublisher`.
- **Ops-dashboard/management REST controllers** (`ViewController`/
  `AutomationsManagementController`/`OutboxManagementController`/`DashboardController`) - each
  surfaces a `*ManagementService` that already exists as a library API; wiring it to HTTP is
  presentation, not proof-of-composition.
- **springdoc/OpenAPI** and the **virtual-thread test** - same reasoning as Phase 7.


## Phase F - append conditions with real multi-item semantics (correctness fix)

Found by the API-redesign design spike (see the plan) while comparing the prototype against the
existing wallet handlers. Two independent defects in `append_events_if`, both reproduced by tests
before fixing (details and decision in the addendum to
[ADR-0003](docs/adr/0003-non-commutative-append-concurrency-protection.md)):

- A multi-item `Query` was flattened into one type list + one tag list, turning OR-of-items into an
  AND, so conflicts were missed for any multi-item decision model.
- A `pg_snapshot_xmin` visibility filter excluded committed conflicting events whenever an unrelated
  transaction was open.

Fix: `V4__crablet_multi_item_append_conditions.sql` (structured JSONB items, per-item advisory locks,
no xmin filter) + `internal/sql.ts` sending unflattened items. New regression tests in
`packages/eventstore/test/integration/append-multi-item.test.ts` (9 tests, incl. the overlapping-
conditions race, which fails 13/15 rounds with whole-condition locks).

Also found, not yet fixed (tracked in the plan, Phase 5): the wallet's `WalletBalanceProjector`
mis-attributes a transfer's receiver balance, and folding `newBalance` snapshots loses updates for
concurrent (commutative) deposits.

Test-infra note: Testcontainers' 10 s "container ports bound" wait is hard-coded, and `node --test` starts
one container per test file in parallel, so integration runs failed intermittently on a busy Docker VM
(`Timed out after 10000ms while waiting for container ports to be bound to the host`; never an
assertion). Fixed in `@crablet/test-support`: container starts are serialized across processes with a
mkdir lock, and that specific timeout is retried (3 attempts); the tests themselves still run in
parallel, each on its own container. 4 consecutive full runs clean (98 tests).

Tried and rejected: ONE shared Postgres container with a fresh database per test file. It passes when
files run alone but breaks the poller tests when they run together: the poller only returns events from
finished transactions (`transaction_id < pg_snapshot_xmin(pg_current_snapshot())`, an ordering
guarantee), and that snapshot is cluster-wide, so open transactions in OTHER databases on the same
server hold events back. Production corollary worth remembering: any long-running transaction anywhere
on the cluster delays every poller (views, outbox, automations) until it finishes.

## Phase M - migration to Effect 4 (release candidate, then 4.0.0)

`effect`, `@effect/sql-pg`, `@effect/platform-node` all pinned to `4.0.0` (they were `4.0.0-rc.118` until the stable release on 2026-10-01; the bump needed no code change); `@effect/sql` and
`@effect/platform` dropped (now `effect/sql`, `effect/http`, `effect/http-api`). Decision and the full
list of non-obvious changes: [ADR-0009](docs/adr/0009-effect-4-release-candidate.md). Everything
passes: typecheck, 84 unit tests, 89 integration tests (3 consecutive clean runs).

Things that only failed at runtime, not in the type checker (worth remembering for the next bump):

- `@effect/sql-pg` 4.x is its own wire-protocol client, not node-postgres. `xid8` has no codec, so
  `transaction_id` is now read with `::text`; `int8` columns come back as `bigint` (tests compared
  against strings - the progress-wait predicates passed instantly because `0n !== "0"`).
- The Postgres SQLSTATE moved to `error.reason.cause.code` (undefined-table detection in the two
  progress trackers).
- ADR re-verification: 0004 still true at commit time (Die defect); 0005's `PgClient.notify` bug is
  fixed upstream, so the `notify()` helper was removed; 0006's slow 20-race test is now sub-second.
- Deliberately not done: a thin internal re-export layer for the formerly-unstable modules (the RC
  no longer uses an `unstable/` path prefix; exact pinning is the guard instead).

### TypeScript 7.0.2 (native compiler)

`typescript` bumped 6.0.3 -> 7.0.2 (`tsc` is now the native binary). The whole workspace typechecks with
zero errors on Effect 4's types, unchanged `tsconfig.json` (`module: Preserve`, `moduleResolution:
bundler`, `allowImportingTsExtensions`); a deliberately wrong file is still rejected, so the check is
real. Typecheck dropped from ~2 s to well under 1 s. `@effect/language-service` (which hooks the TS JS
API that TS 7 replaces) is not used here; check before adopting it.

## Phase 1 (API redesign) - simplifying the low level

First step of the redesign plan: remove structure that only existed to mirror the old variants.

- **One write primitive.** `EventStore.append(events, condition?)` replaces `appendCommutative`,
  `appendNonCommutative`, `appendIdempotent` and `appendConditional` (the first three were already
  one-line wrappers over the fourth). Overloaded: without a condition the only failure is `SqlError`;
  with one it can also fail with `Conflict` or `Duplicate`.
- **Two typed errors instead of one string-coded one.** `ConcurrencyException` + `DCBViolation`
  (`errorCode` strings, always-0 `matchingEventsCount`) are replaced by `Conflict { kind: "boundary" |
  "guard" }` and `Duplicate` in `@crablet/eventstore/AppendErrors`. The executor no longer detects a
  duplicate by lower-casing the message and searching for "duplicate operation detected", and no
  longer re-labels `DCB_VIOLATION` to `GUARD_VIOLATION`: the decision knows whether its check is a
  guard, and the executor sets `kind` accordingly.
- **One decision shape.** `CommandDecision` is `Append | NoOp`. `Append` is `events` + an
  `AppendCondition` + `onDuplicate` + `conflictKind`; the five old variants and the executor's
  per-variant `switch` are gone. The old builders (`commutative`, `nonCommutative`, `idempotent`,
  `withLifecycleGuard`, `noOp`) remain as named constructors of that shape until `defineCommand`
  replaces hand-written handlers; `withIdempotency` adds an idempotency check to any `Append`, which
  makes **strict + idempotent** expressible for the first time (it was impossible: `NonCommutative` had
  no idempotency field, which is why the old Withdraw handler hand-rolled a racy `exists()` check).
  New tests cover it, plus the boundary `Conflict`.
- **Kept as-is on purpose:** the HTTP wire contract (409 with `violationCode`, now derived from the
  error type; `matchingEventsCount` stays 0 because the SQL never reported a count - to be dropped when
  the HTTP mapping is redone in Phase 6); `project`/`StateProjector` (they go away with `defineModel`).
- **Metric semantics changed:** `crablet.eventstore.concurrency_violations` now counts only `Conflict`;
  it used to count idempotency duplicates too.

## Phase 2 (API redesign) - `defineEvent` and `defineModel`

New in `@crablet/commands`: `Event.ts` and `Model.ts` (subpath exports `./Event`, `./Model`), ported from
the Phase 0 spike to Effect 4 and the Phase 1 API.

- `defineEvent(type, { schema, tags })`: one declaration owns the type name, payload schema, tag
  derivation and queries. Calling it builds the `AppendEvent`; `.decode` validates stored data;
  `.where({ tag: value })` builds a query and only accepts tag keys the event declares (a typo is a
  compile error - tested with `@ts-expect-error`).
- `defineModel({ by, initial, scope? }).lifecycle(...).on(...)`: a chained builder. The state fold AND
  the boundary query come from the same handlers, so they cannot drift. `lifecycle` events are bound by
  id only and not scoped; `on(..., { by: [tagA, tagB] })` binds a two-party event through either tag
  (one query item per tag); handlers get `{ event, id }` so they can tell which side they are.
  `.of({ id, ...scope }).load(eventStore)` returns `{ state, logPosition }`; `lifecycleQuery(id)` is the
  natural guard query. `all({ from, to })` (in `Model.ts`) is one boundary over several entities: the
  union of the queries, one position, each member's own state; the boundary is read first, so a race
  can only surface as an extra safe conflict, never a missed one.
- The builder is chained rather than array-based because TypeScript cannot drive a nested generic call
  from the enclosing call's in-progress inference (the state type collapses to `unknown`) - found in
  the spike.
- Proved on the real wallet domain (`examples/wallet-example-app/src/domain/WalletModel.ts`, added
  next to the old definitions; Phase 5 switches the commands over and deletes the old ones): the derived
  queries equal `WalletQueryPatterns`, the events equal `WalletEvents`, the fold equals
  `WalletBalanceProjector` - and the two known wallet bugs are fixed and asserted (F2: the receiver of
  a transfer; F3: concurrent deposits fold by amount, so none is lost). Also against real Postgres: the
  model's `(query, logPosition)` works as a real append condition, for one wallet and for two.
- Test support: `@crablet/eventstore/testing/FakeEventStore` - an in-memory `EventStoreService` for
  unit tests that matches queries like the SQL read path and records appends. It does NOT enforce
  append conditions (the enforcing in-memory store is a later phase). `test:unit` now also runs
  `examples/*/test/*.test.ts`.
- Not done (deliberately): a type-only form of `defineEvent` without a schema; `project`/`StateProjector`
  remain until commands stop using them (Phase 3/5).

Known flake, seen once in ~15 runs on a busy machine: a test's `PgClient` failing with "Connection timed
out" at connect (the client's default connect timeout). Same family as the container-start timeout; if
it recurs, centralise the test `PgClient.layer(...)` in `@crablet/test-support` with a longer timeout.

## Phase 3 (API redesign) - `defineCommand`, `run`, retry, typed errors

`@crablet/commands/Command` (+ `Errors`): a command is one declaration; `decide` is pure.

```ts
const Book = defineCommand({
  name: "book_seat",
  input: Schema.Struct({ seatId: Schema.String, guest: Schema.String, bookingId: Schema.String }),
  model: (c) => SeatModel.of({ id: c.seatId }),                      // state + consistency boundary
  idempotentBy: (c) => SeatBooked.where({ booking_id: c.bookingId }),  // optional
  decide: (seat, c) => seat.taken ? fail(new SeatTaken({ seatId: c.seatId })) : emit(SeatBooked(c))
});
yield* executor.run(Book, rawInput);   // validate -> transaction -> retry on Conflict
```

- **Pipeline** (inside the executor's transaction): idempotency pre-check -> `prepare` -> load the model
  -> `decide` -> append under the condition the consistency implies. `strict()` is the default (fail if
  anything in the model's boundary changed since load); `concurrent({ guard? })` for commands safe to run
  in parallel with themselves; a model-less command defaults to `concurrent()`. Consistency and
  idempotency are independent, so all six combinations work (unit-tested against the expected
  `AppendCondition`s).
- **`idempotentBy` depends on the input only and runs BEFORE `prepare`/`decide`** (and is re-checked
  atomically at append). On a retry the state has moved on, so re-deciding could wrongly fail - this is
  what the old Withdraw handler hand-rolled (racily) with an `exists()` pre-check.
- **`run(command, raw)` validates** (`InvalidInput`) then executes; **`runDecoded(command, typed)`** skips
  validation (automations use it). **Conflict retry**: a `Conflict` re-runs the whole command - fresh
  transaction, fresh load, pure `decide` again - up to `command.retries` (default 3; 0 disables), counted
  in `crablet.command.conflict_retries`. The loser of a race therefore usually ends with the DOMAIN
  answer ("seat taken"), not a `Conflict`. `Duplicate` reaches the caller only for commands that declare
  `onDuplicate: "fail"`.
- **Errors are inferred**: the command's error type is the union of every `fail(...)` in `decide`, plus
  `prepare`'s failures, plus `Duplicate` only when opted in (compile-time asserts in
  `command.test.ts`, sanity-checked to fail when wrong). `DomainError(tag, { fields, kind })` declares a
  domain error with a neutral `kind` (`not_found | invalid | conflict | forbidden`) - NOT an HTTP status;
  commands-http will map kinds in Phase 6. The wallet's errors now use it (same names/fields/tags).
- **Automations** bind a defined `Command<T, HE>` instead of (command-type string + raw handler);
  decisions carry the command's `input`; the module runs them with `runDecoded`. The wallet's welcome
  notification is now a `defineCommand` (model-less, idempotent per wallet).
- Tested against real Postgres with a barrier in `prepare` so BOTH commands load before EITHER appends
  (deterministic, no timing luck): same-seat race -> one wins and the loser fails with the domain error;
  `retries: 0` -> the loser surfaces `Conflict`; different seats never conflict; strict + idempotent race
  -> one Created + one Idempotent; `onDuplicate: "fail"` (sequential and racing).
- Still to come: the hand-written wallet handlers (`CD.*`) are replaced in Phase 5; `ExposedCommand`/HTTP in
  Phase 6. `execute` stays public until then.

## Phase 4 (API redesign) - testability: spec, in-memory store, scenarios, conformance

Goal: test command logic fast and without Docker, WITHOUT trusting a stand-in that might disagree with
Postgres.

- **`@crablet/eventstore/spec/Spec`**: what reads and conditional appends mean, as pure functions
  (`itemMatches`, `queryMatches`, `checkAppend`): an item matches on ANY-of types AND ALL-of tags; a
  query is an OR of items; an append is refused as `duplicate` (idempotency query matches at any position,
  checked FIRST) or `conflict` (concurrency query matches something NEWER than the position). Items with no
  information are dropped; a condition with none performs no check, while a READ with none matches all.
- **`InMemoryEventStore`** (`@crablet/eventstore/testing/InMemoryEventStore`, replaces the Phase 2
  `FakeEventStore`): implements the spec WITH enforcement - `Conflict`/`Duplicate` exactly when Postgres
  would, same messages, correlation/causation ids recorded - plus an exclusive, all-or-nothing
  `transaction(effect)` (rolls back on failure, defect or interruption). It cannot model concurrency:
  nothing interleaves, so races and conflict retries are Postgres-only tests.
- **Conformance suite** (`test/conformance/cases.ts`, 19 framework-neutral cases): the same cases run
  against the in-memory store (Bun, `test/conformance-in-memory.test.ts`) and real Postgres
  (`test/integration/conformance-postgres.test.ts`).
- **Differential test** (`test/integration/differential.test.ts`): 8 seeded random histories x 150 steps
  (random events, random multi-item concurrency/idempotency conditions, random reads) applied to both
  stores in lockstep; every append outcome and every read must be identical. It asserts it exercised every
  outcome (497 accepted / 163 conflicts / 110 duplicates / 359 non-empty reads), so it cannot pass
  vacuously. Mutation-checked: swapping the spec's idempotency/concurrency order fails both the suite and
  the differential test.
- **`given(...events).when(command, input)`** (`@crablet/commands/testing/Scenario`): runs a command through
  the REAL pipeline (validation, idempotency check, prepare, load, decide, conditional append, conflict
  retry) against the in-memory store and returns `{ outcome, events, error, reason }`; later `when`s see
  earlier effects; a defect fails the test loudly. The executor's transaction-independent core
  (`runHandler`) and retry loop (`withConflictRetry`) were extracted so the real executor and the
  scenario runner share one implementation.

**A real bug found by the conformance suite (fixed):** tag values containing a comma (also quotes, braces
or backslashes) were silently stored as DIFFERENT tags. `encodeTagsLiteral` built an unescaped Postgres
array literal (`{k=a,b}` - two elements), a constraint inherited from the predecessor and kept "bug for
bug". Every element is now double-quoted and escaped. Reads were always fine (their values are bound
parameters), so the damage was on write: such events could not be found by their own tags, which breaks
idempotency keys and consistency boundaries on those values. Covered by a permanent conformance case.

Side-task from the plan, already done in Phase F: the `pg_snapshot_xmin` filter that could hide committed
conflicts was removed there (and is covered by `append-multi-item.test.ts`). Not done: the optional PGlite
(Postgres-in-WASM) tier - the in-memory store plus the conformance/differential proof covers the need.

## Phase 5 (API redesign) - the wallet example ported

The regression gate for the whole redesign: the five wallet commands, the statement-period resolver and the
balance fold now use `defineCommand` / `defineModel`; `WalletBalanceProjector.ts` and
`WalletQueryPatterns.ts` are DELETED (their job is the model's); `WalletEvents.ts` shrank to event-type
names and payload types derived from the event definitions (the views read those). The existing wallet
end-to-end suite - HTTP 404/400/409 mappings, automation, correlation/causation, outbox, statement views -
passes with its ASSERTIONS UNCHANGED (only how `domain-commands`/`wallet-model` tests invoke commands
changed: `executor.run(Deposit, ...)` instead of `execute("deposit", ..., handler)`). 129 integration tests,
2 clean runs.

**Measured** (code lines, excluding comments, blanks and imports; before = the pre-redesign code):

| | before | after |
|---|---|---|
| OpenWallet | 20 | 9 |
| Deposit | 40 | 14 |
| Withdraw | 55 | 15 |
| TransferMoney | 69 | 41 |
| CloseWallet | 12 | 11 |
| **the five commands** | **196** | **90** |
| statement-period resolver | 132 | 73 |
| balance projector + query patterns + event constructors | 189 | 14 (derived event names/types) |
| whole domain incl. the new model file | 517 | 294 |

Transfer misses the plan's "~20 lines" target: it is the one command that needs a two-wallet `prepare`, a
combined model, a long refusal chain and four period/statement tags on its event; the structure is right
but it is not short. Deposit and Withdraw hit the target (14 and 15).

**Behaviour changes worth knowing**
- Input validation moved into the schemas: a non-positive amount, a blank name, a negative initial balance
  or a wallet transferring to itself is now `InvalidInput` (HTTP 400 "Invalid payload") instead of a
  domain `InvalidOperation` (which the HTTP layer had no mapping for, so it surfaced as a 500).
- Withdraw's hand-rolled `exists()` pre-check is now `idempotentBy`, checked again atomically at append.
- The resolver's `ActivePeriod` no longer returns a log position (nothing used it: the command's model
  loads its own after `prepare`).
- The two wallet bugs from the spike stay fixed (receiver balance; concurrent deposits fold by amount).
- HTTP: `commands-http` now exposes DEFINED commands (`exposedCommandOf(command, mapError?)`): decoding is
  the command's own schema, execution is `runDecoded`, so HTTP gets conflict retry too. (Pulled forward
  from Phase 6, because the wallet app could not keep running without it.)

New tests: `wallet-commands.test.ts` (16 BDD tests of the real wallet commands with NO database, using
`given(...).when(...)`, incl. "a deposit to an unknown wallet leaves no statement behind" and "a retried
withdrawal is 'already done' even though the balance no longer covers it"); `wallet-model.test.ts` now
asserts the model directly (queries, fold, both regressions).

## Phase 6 — Edges + docs (API redesign)

- `commands-http`: domain errors map by neutral `kind` (not_found/invalid/conflict/forbidden) to status + RFC 7807
  body; `exposedCommandOf` overloads; an error without a `kind` fails to compile. `matchingEventsCount` dropped.
- `Crablet.layer(pg)`: one layer from a Postgres config (hides the `provide` vs `provideMerge` trap).
- README rewritten; its quick start is the verbatim body of `packages/commands/test/quickstart.test.ts`. ADR-0010.
- Sweep: every reference to the predecessor framework (porting notes, its class names, its tooling) was removed from source, tests, SQL
  comments and the wallet example (comments reworded to say what the code does, not where it came from).
  ADRs 0001-0008 and the early NOTES entries now call it "the predecessor" and keep the historical comparison.
- Deleted `CommandExecutor.execute`, the public `CD.*` builders and the `@crablet/commands/CommandDecision` export;
  `CommandDecision` is internal to `defineCommand`. The old executor test is replaced by lifecycle-guard tests
  on defined commands (guard Conflict between load and append; guard + idempotency).

## V5 - writer-side (type, tag) locking

- Reproduced the V4 gap first: an in-flight writer (held open inside a transaction) whose events match a checker's
  condition did not make the checker wait, so the checker committed past it. `append-writer-locking.test.ts` failed
  2 of 3 on V4 and passes on V5.
- `V5__crablet_writer_side_locking.sql`: every append exclusively locks the (type, tag) pairs of its events and of its
  condition items (concurrency and idempotency), plus shared type/global intent locks; tag-less / type-less items take
  the matching intent lock exclusively. Locks are taken in one sorted loop.
- New hazard, reproduced then fixed: a command that appends in `prepare` and then reads other entities can deadlock
  with a mirror-image command (Postgres reports 40P01 after ~1s). `CommandExecutor` now maps it to `Conflict`, so the
  command is re-run (`deadlock-retry.test.ts`).
- Measured cost (16 writers x 150 appends, one run): hot single (type, tag) unconditional 7.6k -> 2.6k appends/s;
  guarded hot 2.3k -> 2.0k; distinct keys -5..-16%.
- Flake seen again: a wallet integration file failed once to start its container; re-running passed.

## List-valued tags

- `defineEvent`'s `tags` may return a list for a key: one tag per distinct element, same key
  (`tags: (d) => ({ product_id: d.items.map((i) => i.productId) })`). Empty list = no tag for that key. `where({ product_id })`
  still takes a single value. Found while writing the dcb.events examples (`test/support/dcb-examples.ts`), where an
  order touches many products and a rename touches two usernames; both previously needed `extraTags` or two tag keys.
- Each extra tag is one more (type, tag) append lock (V5), so keep lists modest.

## Read your own writes (V6 + waitUntilProcessed)

- `append_events_if` now returns the position of the last appended event (`V6__crablet_append_returns_position.sql`:
  `append_events_batch` returns it, `last_position` in the JSONB result). `EventStore.append` returns
  `AppendResult { transactionId, lastPosition }` (was the transaction id string); the in-memory store does the same,
  and a conformance case checks both stores. `ExecutionResult.lastPosition` carries it (null for an idempotent repeat).
- `@crablet/views/WaitUntilProcessed`: `waitUntilProcessed(subscription, position, { timeout, interval })` polls the view's
  progress. "Caught up" is NOT "progress >= position": a view's cursor only lands on events its subscription matches, so a
  command whose last event the view ignores would never reach it. A view has caught up when progress passed the position OR
  no committed event the subscription matches remains in (progress, position] (`hasPendingSelectedEvents` in event-poller,
  which, unlike the poller's own fetch, has no xmin visibility cut-off - it asks what exists, not what is safe to read yet).
  Typed failures: `WaitTimeout` (reports how far the view got) and `ViewFailed` (status FAILED: fail fast).
- Not done: waiting on outbox / automations progress (same idea, other progress tables); a poll-free wake-up via NOTIFY.

## OpenAPI phase 2 - per-command routes (commands-http)

- One route per exposed command (`POST {basePath}/{name}`) built from the registry at startup; the request body is the command's input schema, the
  documented failures are the framework's own plus the command's DECLARED domain errors (`exposedCommandOf(command, { errors: [...] })`, checked at
  compile time). Problems are `application/problem+json`. The generic `{ commandType, command }` endpoint, `mapError` and `extraErrors` are removed.
- Handlers use `handleRaw` and the command's own `decodeInput`: HttpApi's default payload failure is an empty-bodied 400, ours is a problem body. This also
  fixed the old "malformed JSON gives an empty body" follow-up.
- Response: `{ status: "CREATED", reason: null, lastPosition: "<position>" }` (201) or `{ status: "IDEMPOTENT", reason, lastPosition: null }` (200).
- Wallet ported: registry declares errors per command, `InsufficientFundsProblem` deleted, e2e tests post to the new paths and assert the new problem shape
  (`errorType` + `fields`). `command-api-description.test.ts` checks the generated description without a server.

## OpenAPI phase 3 - the description, served and checked in

- `HttpApiBuilder.layer(api, { openapiPath })` serves the document (default `/openapi.json`); `docs: { ui: "scalar" | "swagger" }` mounts a page (off by default).
  `ApiDescription.ts` (`apiLayerOptions`, `apiDocsLayer`) is shared by `makeCommandApiLive` and the wallet app; `withApiInfo` sets title / version / description.
- Valid and stable: `wallet-openapi.test.ts` validates the generated document with `@readme/openapi-parser` and compares it with `docs/api/wallet-openapi.json`
  (`bun run docs:api` regenerates it). An API change is a visible diff; a stale file fails the unit test (so CI).
- Findings: `Schema.optional(X)` renders as `X | null` but the decoder refuses null -> use `Schema.optionalKey` (the input lint reports it); `Schema.Number` anywhere in
  the document renders as number-or-"Infinity" -> `Schema.Finite` (fixed in the wallet's error fields and read responses; the test asserts none remain).

## OpenAPI step 1b - `errors` declared once, on the command

- `defineCommand({ errors: [WalletNotFound, ...] })` replaces the exposure-time list: it is the single declaration, checked against `decide` and `prepare` (a domain error
  that is not listed is a compile error naming it; non-domain errors are not subject to it). `Command.errors` carries the classes; `exposedCommandOf(command)` no longer takes
  options and the API reads `command.errors` for the documented responses. Found by asking "decide already declares them" - the list must exist at run time (types are
  erased) but need not be a second copy.

## OpenAPI phase 4 - read your own writes over HTTP

- `POST /api/commands/<name>?waitFor=<view>&waitTimeout=<ms>`: after the command commits, the handler waits (via the app's `ViewWaiter` for that name) and reports
  `view: { name, caughtUp, reason? }` in the 201/200 body. Failure to catch up is reported in the body, never as an error status. Idempotent repeats report
  `nothing_appended` and do not call the waiter. Bad parameters are a 400 problem before the command runs (verified: nothing written).
- `ViewWaiter` (commands-http) is structural: `waitUntilProcessed(subscription, position, { timeout })` satisfies it; the wallet maps each of its 4 view names.
- The docs/api wallet document was regenerated (query parameters + `view` in the responses).

## OpenAPI phase 5 - client, README, ADR-0011

- `HttpApiClient.make(makeWalletApi(), { baseUrl })` drives the wallet over real HTTP in `lifecycle-e2e.test.ts` (open, deposit with `waitFor`, a read, a declared domain error
  arriving as its typed problem). The command routes are untyped (`any`) in the derived client because the endpoint set is built at run time; the read group is typed. When every
  command route declares `query` (views waitable) the client requires `query: {}`. Typed command clients come from an OpenAPI generator on the document.
- README "HTTP API and OpenAPI"; `docs/adr/0011-http-api-from-the-domain-model.md` records the decisions (per-command routes, errors on the command, problem+json, checked-in
  description, read-your-writes outcome in the body, no GraphQL) and the changes for HTTP clients.

## Tutorial - course enrolment (docs/tutorial/course-enrolment.md, examples/course-enrolment-app)

- Four steps: (1) a capacity-only rule in memory (`tutorial/step1-capacity-only.test.ts`, no Docker); (2) the final two-rule domain against Postgres
  (`docker compose up`, `src/migrate.ts`, `scripts/step2-postgres.ts`); (3) the HTTP API + generated OpenAPI (`src/CourseApp.ts`, checked-in
  `docs/api/course-enrolment-openapi.json`); (4) a seats-left view, `GET /api/courses/:id` and `?waitFor=course-seats-view`.
- It cannot rot: `test/tutorial-sync.test.ts` fails when a tagged code block differs from its `// #region` in the source (it caught a real drift while writing),
  when a link / script / test path is missing, or when a curl URL is not a route of the checked-in spec.
- Followed literally from a fresh `docker compose down -v` it reproduces the document's outputs verbatim (positions 10-14 included).
- Honest limits: steps 2-4 need Docker (no in-memory executor, by decision); step 2's race is natural, not forced - the forced-overlap proofs for the same domain are in the commands
  package's tests; the view projector guards redeliveries with `last_position`.

## Privacy P1 - marking personal data (packages/commands/src/Personal.ts)

- `personal(schema)` marks a field once, where it is declared (an event payload or a command input). It is a NO-OP CHECK, not an annotation: in Effect an annotation added after `.check(...)` attaches to the last
  check, so a walker would miss it depending on the order the schema was written in; a check is always found, survives composition, does not change decoding and emits `x-personal: true` into the generated JSON Schema.
- `personalPaths(schema)` lists the marked paths (`email`, `addresses.[].street`, `notes.*`, `(root)`), `redact(schema, value)` returns a copy-on-write copy with them replaced by `"[redacted]"` (unknown keys are left for the caller;
  `Schema.Class` is not walked; unions are conservative). `EventDef.schema` is now exposed (the event log API and the masking read it).
- Upstream finding (rc.118): `Schema.isMinLength(n)` is described as `minLength: n-1` in the generated JSON Schema (the decoder is right). Not used on exposed inputs today; re-check on Effect 4.0.0.

## Privacy P2 - the command audit (packages/commands/src/CommandAudit.ts)

- `CommandExecutor` now records every command that APPENDED events in `crablet_commands`, in the command's own transaction: the row's `transaction_id` is the transaction that wrote its events ("which request caused this
  event?"), and a refused, rolled-back or stale-then-retried attempt leaves no row. Idempotent repeats and no-ops record nothing.
- What is stored is minimal by default: `payload: "redacted"` (fields marked `personal(...)` replaced by `"[redacted]"`), `"none"` (no input), `"full"` (explicit opt-in), `"off"` (no row). Set with `Crablet.layer(pg, { audit: { payload } })`
  (a `Context.Reference`, overridable with `Effect.provideService`). Metadata holds the correlation id and an app-supplied actor (`withActor`); without authentication the framework records what and when, not who.
- Retention: `purgeCommandAudit({ olderThan })` and `startAuditRetention({ olderThan, every })` (a detached fiber, off unless the app starts it). The table is not the source of truth, so deleting is safe.
- Cost to know: one extra INSERT per created command (it is in the same transaction). `command.name` must be 1-64 characters (checked at definition) because the column is limited to 64.
- `crablet_module_scan_progress` / `crablet_processor_scan_progress` remain unused.

## Privacy P3 - the tag guard and the examples

- `defineEvent` refuses to build an event whose tag value equals a value in a field marked `personal(...)` (trimmed, case-insensitive; list tags, numbers and `extraTags` included). It catches direct reuse only: a derived
  value (a hash, an opaque id) is what a tag should use and is accepted. Events without personal fields are untouched.
- Examples fixed: the wallet's `owner` is personal in `WalletOpened`, `OpenWallet`, `SendWelcomeNotification` and `WelcomeNotificationSent` (the wallet spec now flags it `x-personal`); the DCB opt-in-token example tags an opaque
  `email_key` (sha-256 prefix) instead of the email; the username example keeps the handle as its uniqueness tag with a comment on the trade-off; the tutorial says to use opaque ids in real systems.

## Cursor fix - (transaction_id, position) (docs/adr/0012-transaction-position-cursors.md)
- Found by a stress test: pollers permanently skipped 0.05-0.09% of events under concurrent writers, and the append condition could miss a conflict. Cause: `position` (nextval) and `transaction_id` (xid) can be taken in opposite orders, and `nextval()` itself assigns the transaction an xid. The deterministic reproductions are `packages/event-poller/test/integration/cursor-inversion.test.ts` and `packages/eventstore/test/integration/append-cursor-inversion.test.ts`.
- V7 (append condition cursor) and V8 (progress tables, with a backfill that cannot put an undelivered event behind the cursor). Interfaces changed: `getCursor/updateCursor`, `fetchEvents(id, cursor, n)`, `waitUntilProcessed(sub, write)`, `ExecutionResult.lastTransactionId`.
- Process: the integration suite starts one Postgres container per file; with 30+ files in parallel an occasional "before hook" hits its 60 s limit. Re-run the failing files alone before suspecting the code.

## Course UI - a Foldkit page for the course-enrolment API (examples/course-enrolment-ui, tutorial step 5)
- A one-page client (define a course, subscribe a student, look a course up) built on Foldkit 0.165.0 (pinned exactly; beta) and Effect 4.0.0. Its client is DERIVED from the API definition the server serves: `course-enrolment-app/src/CourseApi.ts` was split out of `CourseApp.ts` for that (no database, view processor or Node module, so a browser bundle can import it; +57 kB). Vite proxies `/api` to the course app (no CORS in `commands-http`).
- Tests: Foldkit Story/Scene tests run under `bun:test` (no vitest needed); `test/integration/page-against-server.test.ts` drives the page's real `update` and Commands against the real course app on Postgres (a ten-line driver plays Foldkit's runtime; `globalThis.location` is the base URL a browser would supply). The UI package has its own tsconfig (DOM lib); the root typecheck excludes it and chains its script.
- Demo knob: `COURSES_VIEW_DELAY_MS` (default 0) / `startCourseViews(id, { viewDelayMs })` holds the seats view back so staleness is visible; the delay is spent before the projector's transaction opens.
- What building it showed, ranked as follow-ups (each its own plan if chosen): (1) a TYPED command client (DONE - see "Typed command client" below); (2) optional CORS in `commands-http` (DONE - see "Opt-in CORS" below); (3) a list/search read pattern (DONE - see "Course list" below); (4) per-field validation problems from the server (DONE - see "Field-level 400" below); (5) live updates (no push channel). Also: a server whose database is down answers 500 and logs a `SchemaError` from building the problem body rather than the Postgres error.
- Process gotchas: the local Postgres container stopped between sessions more than once (`docker compose up -d` brings it back; a database created in it survives); `bun test examples/<pkg>/test` also runs the `integration/` subdirectory, so point it at a file; a full `test:integration` run can hang for a long time when one file's container-startup `before` hook times out (the late server keeps the process alive) - kill the run, remove the stray testcontainers, rerun the failed files alone.

## Typed command client (docs/plans/typed-command-client.md, ADR-0011 addendum)
- `Command<In, Err, I, Es>` / `ExposedCommand<T, E, I, Es>` keep the input Schema and the declared error classes in their type (defaults = the erased types, so nothing else changed); `makeCommandApiGroup` / `makeCommandApi` are generic over the registry and return a `CommandGroup` with one typed endpoint per command. Runtime and OpenAPI output unchanged.
- The registry must be an unannotated object literal (the wallet app, the course app and the tutorial's `expose` block were changed); `problemSchemaOf` now returns its precise `ProblemBody` type, which let the course read endpoint drop its `as never`.
- The page (examples/course-enrolment-ui/src/api.ts) has no cast: `client.commands.execute_subscribe({ payload, query })`, and `problemFromError` matches on `errorType` with a `never` default, so a declared error the page does not handle stops it compiling (checked by removing a case).
- Type tests are `*.types.ts` files (checked by the root typecheck, never executed); each was verified to fail when an expectation is wrong.
- Process: run the integration suites in batches of a few files. All of them at once starts dozens of Postgres containers, several hit the 60 s setup timeout, and a file whose setup times out can leave a process alive, so the run never ends.

## Field-level 400 (docs/plans/api-follow-ups.md item A, ADR-0013)
- The 400 for a body that parses but does not match a command's input now carries `errors: [{ path, message }]`, one per failed field (paths are property names and array indexes, e.g. `["user","tags",1]`). `InvalidInput` carries the same as `issues` (built from the `SchemaError` with Effect's Standard Schema formatter), and the server decodes input with `errors: "all"` so EVERY field is reported, not only the first. A body that is not valid JSON, and the other 400s, have no `errors`.
- Built-in schema messages never contain the received value (checked: `Expected string`, `Expected number`, even for `"secret-value"`); tests pin that the sent value is not in the response, for future custom messages.
- OpenAPI: purely additive (`CommandApiBadRequest.errors`, a new `InputIssue` component; 66 lines added to each document, none removed) - the first change made under ADR-0013's additive/breaking rules.
- The TypeScript page never sees it (its derived client validates with the same Schema before sending and reports a `SchemaError`); the value is for clients that do not validate first. The page's `Rejected` case shows the paths when present.

## Browser-safety guard (docs/plans/api-follow-ups.md, item F's first step)
- `examples/course-enrolment-app/test/browser-safe.test.ts` bundles `src/CourseApi.ts` for the browser in-process (`Bun.build`, metafile, about 80 ms) and fails on any Node module, Postgres driver or server-side package it reaches. It runs in CI through `test:unit`, which closes the gap that CI never builds the UI. The server entry `CourseApp.ts` is the built-in negative control; a `node:os` import added to the domain module was checked to fail it.
- After the contract/behavior split (item F proper) the same test is tightened to forbid anything from the server-side domain module.

## Opt-in CORS (docs/plans/api-follow-ups.md item C)
- `@crablet/commands-http/Cors` exports `corsLayer({ allowedOrigins, ... })`: router-level middleware (`HttpRouter.middleware(HttpMiddleware.cors(...), { global: true })`), merged next to the API layer. An app that does not call it sends no CORS header. Effect's own `cors` has two permissive defaults the helper removes: an EMPTY `allowedOrigins` means `Access-Control-Allow-Origin: *`, and an empty `allowedHeaders` reflects whatever the browser asks for. The helper REQUIRES a non-empty origin list (or a predicate), sets the API's own methods (GET, POST) and headers (Content-Type, X-Correlation-Id), exposes X-Correlation-Id, caches the preflight 600 s, and refuses `credentials` together with `"*"` at construction.
- Must be router-level: Effect documents that middleware given to `HttpRouter.serve({ middleware })` cannot change the response it wraps. A global router middleware also answers a preflight for a path with no route and adds the headers to 4xx/5xx responses (both pinned by tests).
- With ONE configured origin Effect always answers that origin (the browser compares it with the page's own origin, so any other page is blocked); with several, an unlisted origin gets no header.
- Course app: `CourseAppConfig.cors`, `COURSES_CORS_ORIGINS=<comma-separated origins>` in `src/index.ts`. The page: `VITE_API_URL` (read as `import.meta.env`; absent under Node, so the e2e test keeps using `globalThis.location`). The Vite proxy stays the default dev setup.
- Tests: `packages/commands-http/test/cors.test.ts` (11, no database) and `examples/course-enrolment-app/test/integration/course-cors.test.ts` (the real routes), `examples/course-enrolment-ui/test/api-base-url.test.ts`.

## Course list (docs/plans/api-follow-ups.md item D)
- `GET /api/courses?limit=&after=&q=` -> `{ items: [course...], next: string | null }` over `course_seats_view`: keyset pagination on `course_id` (no OFFSET), one extra row read to know whether there is a next page, `limit` 1-100 (default 20) validated by the handler so a bad value is the usual 400 problem, `after` an opaque cursor (the previous `next`), `q` an id-prefix filter whose `LIKE` characters (`\`, `%`, `_`) are escaped. Hand-written like `getCourse`; no query engine and no shared pagination helper (the wallet app does not need a list yet: extract `Page`/cursor helpers into `@crablet/views` only when it does).
- OpenAPI: one new path (`/api/courses`) and a `CoursePage` component; the generator also re-orders some components, so the diff has deletions that are moves.
- The page: loads page one at startup, reloads it after every write (same wait setting as the read-back), a prefix filter, "More", and a click opens the course in the lookup. Collation note for tests: ordering is the database's, so the integration test asserts consistency (pages concatenate to the single page, ids sorted as the database sorted them) and only compares exact order for ids that sort the same under any collation.
- Tests: `test/course-list.test.ts` (helpers), `test/integration/course-list.test.ts` (8, real Postgres: paging, prefix, escaping, bounds, subscriptions), the page's `test/courses.test.ts` and an end-to-end case that really pages (22 courses, 20 per page).

## Contracts, phase 1 (docs/plans/api-follow-ups.md item F)
- `commandContract({ name, input, errors })` (`@crablet/commands/Contract`) is the PUBLIC part of a command; the server spreads it into the unchanged `defineCommand({ ...Contract, model, decide })` (declare the contract as its own const - inline in the spread the error list is silently loosened). `makeCommandApiGroup`/`makeCommandApi` accept a list of contracts; the Live functions take `(contracts, implementations)` and check at construction that each command was built from its contract (`ContractMismatch`). The registry form stays until phase 3.
- Node strip-only mode rejects constructor parameter properties (`constructor(readonly x: T)`); Bun does not, so unit tests cannot catch it. Only `node --test` imports reveal it.

## Contracts, phase 2: the course app (docs/plans/api-follow-ups.md item F)
- `domain/enrolment.contract.ts` (errors + `DefineCourseContract` + `SubscribeContract`, no behavior) and `domain/Enrolment.ts` (events, models, `defineCommand({ ...Contract, ... })`). The API definition (`CourseApi.ts`, `CourseQueryApi.ts`) imports only the contract module; the page's bundle no longer contains `Enrolment.ts` or the command pipeline, and the browser-safety guard enforces it (it fails on the previous layout).
- The server registers `courseImplementations: Implementations<typeof courseContracts>`; a missing, extra or cross-assigned command is a compile error, and a command not built from its contract is refused at startup.

## Contracts, phase 3: the wallet app and the cleanup (docs/plans/api-follow-ups.md item F, done)
- The wallet declares its API from `domain/WalletContracts.ts` (five contracts); the registry form is removed everywhere (`exposedCommandOf`, `ExposedCommand`, the registry overloads). The API is declared from `[...contracts]`; the server registers `(contracts, implementations)` and `checkImplementations` refuses a missing, extra or look-alike command at startup.
- `@crablet/test-support/BrowserSafety` (Bun-only, `Bun.build`) is the shared in-process browser-bundling check; each app's `test/browser-safe.test.ts` forbids server-only modules, its behavior modules and the command pipeline in the bundle of its contracts / API definition, with the server entry as the negative control.
- Net effect for a new exposed command: write its contract in the contract module, build the command with `defineCommand({ ...Contract, ... })`, add the contract to the list and the command to the implementations (a compile error says if either is forgotten).


## Live updates, phase 1: the progress ping (docs/plans/api-follow-ups.md item E)
- `ProgressTableSpec.notifyChannel` (opt-in per tracker): `updateCursor` becomes ONE statement - the UPDATE plus `pg_notify(channel, {id, transactionId, position})` - so the ping is delivered only when the advance commits, never on a failed batch. Views set it (`VIEW_PROGRESS_CHANNEL = "crablet_view_progress"`, `@crablet/views/ViewProgress`); automations and outbox do not. `@crablet/event-poller/ProgressPing` is the shared payload schema/decoder.
- Tests: `event-poller/test/integration/progress-notify.test.ts` (a ping per advance, none on rollback, none without the channel) and `views/test/integration/view-progress-ping.test.ts` (a running view's ping covers the write's cursor; an idle view is silent).
- The command response now carries `lastTransactionId` (string; `null` for an idempotent repeat) beside `lastPosition` - together the write's cursor, which a client compares with the ping. Additive; OpenAPI documents and tutorial outputs regenerated.
