# Phase 0 Spike — Findings

Status: all acceptance criteria from the plan (`/Users/rodolfo/Documents/ts-effect-crablet-phase0-plan.md`)
met except where noted. (That was the state after Phase 0: 22/22 tests. On 2026-10-09: 834 unit tests under Bun and 394 integration tests under Node pass (they were 578 and 322 on 2026-10-07); the reliability and scale work is summarized in [`docs/plans/reliability-and-scale-diagnostic.md`](docs/plans/reliability-and-scale-diagnostic.md), and later entries below are in order.)

**This is the working journal**, not documentation: findings, gotchas and what changed against each plan, in the order they happened. To learn the project start at
[`docs/README.md`](docs/README.md); the lasting decisions are in [`docs/adr/`](docs/adr/README.md).

<details><summary>Contents (94 entries)</summary>

- [Runtime: Bun + Node hybrid, not Bun-only](#runtime-bun--node-hybrid-not-bun-only)
- [Risk A: `@effect/sql-pg` calling `append_events_if` — works, idiomatic tier sufficient](#risk-a-effectsql-pg-calling-append_events_if--works-idiomatic-tier-sufficient)
- [Risk B, part 1: LISTEN/NOTIFY — mostly built-in, one real library bug found](#risk-b-part-1-listennotify--mostly-built-in-one-real-library-bug-found)
- [Risk B, part 2: advisory-lock leader election — `sql.reserve` works well](#risk-b-part-2-advisory-lock-leader-election--sqlreserve-works-well)
- [`event-model.yaml` cross-repo sharing — not yet investigated](#event-modelyaml-cross-repo-sharing--not-yet-investigated)
- [Phase 1 — eventstore client + command executor](#phase-1--eventstore-client--command-executor)
- [Summary: what changed vs. the original plan](#summary-what-changed-vs-the-original-plan)
- [Phase 2 — event-poller module](#phase-2--event-poller-module)
- [Phase 3 — crablet-views port + NOTIFY-wiring fix](#phase-3--crablet-views-port--notify-wiring-fix)
- [Phase 4 — crablet-outbox port](#phase-4--crablet-outbox-port)
- [Phase 5 — crablet-automations port](#phase-5--crablet-automations-port)
- [Phase 6 — `@crablet/metrics-otel`: metrics vocabulary + wiring](#phase-6--crabletmetrics-otel-metrics-vocabulary--wiring)
- [Phase 7 — `@crablet/commands-http`: generic REST command API](#phase-7--crabletcommands-http-generic-rest-command-api)
- [Phase 8 — `examples/wallet-example-app`: the first real end-to-end TS application](#phase-8--exampleswallet-example-app-the-first-real-end-to-end-ts-application)
- [Phase F - append conditions with real multi-item semantics (correctness fix)](#phase-f---append-conditions-with-real-multi-item-semantics-correctness-fix)
- [Phase M - migration to Effect 4 (release candidate, then 4.0.0)](#phase-m---migration-to-effect-4-release-candidate-then-400)
- [Phase 1 (API redesign) - simplifying the low level](#phase-1-api-redesign---simplifying-the-low-level)
- [Phase 2 (API redesign) - `defineEvent` and `defineModel`](#phase-2-api-redesign---defineevent-and-definemodel)
- [Phase 3 (API redesign) - `defineCommand`, `run`, retry, typed errors](#phase-3-api-redesign---definecommand-run-retry-typed-errors)
- [Phase 4 (API redesign) - testability: spec, in-memory store, scenarios, conformance](#phase-4-api-redesign---testability-spec-in-memory-store-scenarios-conformance)
- [Phase 5 (API redesign) - the wallet example ported](#phase-5-api-redesign---the-wallet-example-ported)
- [Phase 6 — Edges + docs (API redesign)](#phase-6--edges--docs-api-redesign)
- [V5 - writer-side (type, tag) locking](#v5---writer-side-type-tag-locking)
- [List-valued tags](#list-valued-tags)
- [Read your own writes (V6 + waitUntilProcessed)](#read-your-own-writes-v6--waituntilprocessed)
- [OpenAPI phase 2 - per-command routes (commands-http)](#openapi-phase-2---per-command-routes-commands-http)
- [OpenAPI phase 3 - the description, served and checked in](#openapi-phase-3---the-description-served-and-checked-in)
- [OpenAPI step 1b - `errors` declared once, on the command](#openapi-step-1b---errors-declared-once-on-the-command)
- [OpenAPI phase 4 - read your own writes over HTTP](#openapi-phase-4---read-your-own-writes-over-http)
- [OpenAPI phase 5 - client, README, ADR-0011](#openapi-phase-5---client-readme-adr-0011)
- [Tutorial - course enrolment (docs/tutorial/course-enrolment.md, examples/course-enrolment-app)](#tutorial---course-enrolment-docstutorialcourse-enrolmentmd-examplescourse-enrolment-app)
- [Privacy P1 - marking personal data (packages/commands/src/Personal.ts)](#privacy-p1---marking-personal-data-packagescommandssrcpersonalts)
- [Privacy P2 - the command audit (packages/commands/src/CommandAudit.ts)](#privacy-p2---the-command-audit-packagescommandssrccommandauditts)
- [Privacy P3 - the tag guard and the examples](#privacy-p3---the-tag-guard-and-the-examples)
- [Cursor fix - (transaction_id, position) (docs/adr/0012-transaction-position-cursors.md)](#cursor-fix---transaction_id-position-docsadr0012-transaction-position-cursorsmd)
- [Course UI - a Foldkit page for the course-enrolment API (examples/course-enrolment-ui, tutorial step 5)](#course-ui---a-foldkit-page-for-the-course-enrolment-api-examplescourse-enrolment-ui-tutorial-step-5)
- [Typed command client (docs/plans/typed-command-client.md, ADR-0011 addendum)](#typed-command-client-docsplanstyped-command-clientmd-adr-0011-addendum)
- [Field-level 400 (docs/plans/api-follow-ups.md item A, ADR-0013)](#field-level-400-docsplansapi-follow-upsmd-item-a-adr-0013)
- [Browser-safety guard (docs/plans/api-follow-ups.md, item F's first step)](#browser-safety-guard-docsplansapi-follow-upsmd-item-fs-first-step)
- [Opt-in CORS (docs/plans/api-follow-ups.md item C)](#opt-in-cors-docsplansapi-follow-upsmd-item-c)
- [Course list (docs/plans/api-follow-ups.md item D)](#course-list-docsplansapi-follow-upsmd-item-d)
- [Contracts, phase 1 (docs/plans/api-follow-ups.md item F)](#contracts-phase-1-docsplansapi-follow-upsmd-item-f)
- [Contracts, phase 2: the course app (docs/plans/api-follow-ups.md item F)](#contracts-phase-2-the-course-app-docsplansapi-follow-upsmd-item-f)
- [Contracts, phase 3: the wallet app and the cleanup (docs/plans/api-follow-ups.md item F, done)](#contracts-phase-3-the-wallet-app-and-the-cleanup-docsplansapi-follow-upsmd-item-f-done)
- [Live updates, phase 1: the progress ping (docs/plans/api-follow-ups.md item E)](#live-updates-phase-1-the-progress-ping-docsplansapi-follow-upsmd-item-e)
- [Live updates, phase 2: the feed endpoint (docs/plans/api-follow-ups.md item E)](#live-updates-phase-2-the-feed-endpoint-docsplansapi-follow-upsmd-item-e)
- [Live updates, phase 3: the page (docs/plans/api-follow-ups.md item E)](#live-updates-phase-3-the-page-docsplansapi-follow-upsmd-item-e)
- [Read consistency, phase 0: the wallet transaction list pages by keyset (docs/plans/read-consistency.md)](#read-consistency-phase-0-the-wallet-transaction-list-pages-by-keyset-docsplansread-consistencymd)
- [Read consistency, phase 1: the write marker (docs/plans/read-consistency.md)](#read-consistency-phase-1-the-write-marker-docsplansread-consistencymd)
- [Read consistency, phase 2: what HttpApi supports (docs/plans/read-consistency.md)](#read-consistency-phase-2-what-httpapi-supports-docsplansread-consistencymd)
- [Read consistency, phase 3: `@crablet/views-http` (docs/plans/read-consistency.md)](#read-consistency-phase-3-crabletviews-http-docsplansread-consistencymd)
- [Read consistency, phase 4: the example apps' reads (docs/plans/read-consistency.md)](#read-consistency-phase-4-the-example-apps-reads-docsplansread-consistencymd)
- [Read consistency, phase 5: the Foldkit page sends the marker (docs/plans/read-consistency.md)](#read-consistency-phase-5-the-foldkit-page-sends-the-marker-docsplansread-consistencymd)
- [Read consistency, phase 6: `?waitFor` is gone; the course app reads at `latest` (BREAKING; docs/plans/read-consistency.md)](#read-consistency-phase-6-waitfor-is-gone-the-course-app-reads-at-latest-breaking-docsplansread-consistencymd)
- [Read consistency, phase 7: what a consistent read costs (docs/plans/read-consistency.md)](#read-consistency-phase-7-what-a-consistent-read-costs-docsplansread-consistencymd)
- [Shared listener, phase 1: `ViewProgressHub` (ADR-0016, docs/plans/shared-listener.md)](#shared-listener-phase-1-viewprogresshub-adr-0016-docsplansshared-listenermd)
- [Shared listener, phase 2: `waitUntilProcessed` waits on the hub (ADR-0016, docs/plans/shared-listener.md)](#shared-listener-phase-2-waituntilprocessed-waits-on-the-hub-adr-0016-docsplansshared-listenermd)
- [Shared listener, phase 3: the feed and the apps on the hub (BREAKING for `viewProgressFeed` and the apps' layers; ADR-0016, docs/plans/shared-listener.md)](#shared-listener-phase-3-the-feed-and-the-apps-on-the-hub-breaking-for-viewprogressfeed-and-the-apps-layers-adr-0016-docsplansshared-listenermd)
- [Shared listener, phase 4: measured, and what the measurements corrected (ADR-0016, docs/plans/shared-listener.md)](#shared-listener-phase-4-measured-and-what-the-measurements-corrected-adr-0016-docsplansshared-listenermd)
- [Shared listener, phase 4 follow-up: the "stampede" was the benchmark, not the server (corrects the entries above)](#shared-listener-phase-4-follow-up-the-stampede-was-the-benchmark-not-the-server-corrects-the-entries-above)
- [Reliability and scale: diagnostic and plan (docs/plans/reliability-and-scale-diagnostic.md)](#reliability-and-scale-diagnostic-and-plan-docsplansreliability-and-scale-diagnosticmd)
- [Plan step 1: truthful leadership, a fence and a forward-only cursor (done, uncommitted)](#plan-step-1-truthful-leadership-a-fence-and-a-forward-only-cursor-done-uncommitted)
- [Plan step 2: a wake-up listener that reconnects (done, uncommitted)](#plan-step-2-a-wake-up-listener-that-reconnects-done-uncommitted)
- [Plan step 3: faster failover (done, uncommitted)](#plan-step-3-faster-failover-done-uncommitted)
- [Plan step 4, part 1: where the boundary time goes (measured; no fix yet)](#plan-step-4-part-1-where-the-boundary-time-goes-measured-no-fix-yet)
- [Plan step 4, part 2: ADR-0018 (snapshots), Proposed](#plan-step-4-part-2-adr-0018-snapshots-proposed)
- [ADR-0018 open point 1 resolved: the cursor of an `all(...)` model (analysis, proved by a test)](#adr-0018-open-point-1-resolved-the-cursor-of-an-all-model-analysis-proved-by-a-test)
- [`all(...)` horizon built (ADR-0018 decision 8; uncommitted)](#all-horizon-built-adr-0018-decision-8-uncommitted)
- [Executor-level test for the `all` cursor (closes the gap noted above; uncommitted)](#executor-level-test-for-the-all-cursor-closes-the-gap-noted-above-uncommitted)
- [Snapshot spike: how to write a snapshot when the load is inside the command's transaction (ADR-0018 open point 3; uncommitted)](#snapshot-spike-how-to-write-a-snapshot-when-the-load-is-inside-the-commands-transaction-adr-0018-open-point-3-uncommitted)
- [Migration V9: crablet_model_snapshots (ADR-0018 implementation step 1; uncommitted)](#migration-v9-crablet_model_snapshots-adr-0018-implementation-step-1-uncommitted)
- [SnapshotStore, canonical query and collector (ADR-0018 implementation step 1, second half; uncommitted)](#snapshotstore-canonical-query-and-collector-adr-0018-implementation-step-1-second-half-uncommitted)
- [Load with snapshot + tail (ADR-0018 implementation step 2; uncommitted)](#load-with-snapshot--tail-adr-0018-implementation-step-2-uncommitted)
- [Executor wiring and the E5 re-run (ADR-0018 implementation steps 3 and 4; uncommitted)](#executor-wiring-and-the-e5-re-run-adr-0018-implementation-steps-3-and-4-uncommitted)
- [verify-snapshots (ADR-0018 implementation step 5; uncommitted)](#verify-snapshots-adr-0018-implementation-step-5-uncommitted)
- [Decisions taken (2026-10-06, following the recommendation)](#decisions-taken-2026-10-06-following-the-recommendation)
- [The plan document brought up to date (uncommitted)](#the-plan-document-brought-up-to-date-uncommitted)
- [ADR-0017 spike: the decoding default exists and the policy is implementable (uncommitted)](#adr-0017-spike-the-decoding-default-exists-and-the-policy-is-implementable-uncommitted)
- [ADR-0017 accepted; step 1: the typed EventDecodingError (uncommitted)](#adr-0017-accepted-step-1-the-typed-eventdecodingerror-uncommitted)
- [ADR-0017 step 2: every reader decodes through its definition (uncommitted)](#adr-0017-step-2-every-reader-decodes-through-its-definition-uncommitted)
- [ADR-0017 step 3: the fixtures helper and the first fixtures (uncommitted)](#adr-0017-step-3-the-fixtures-helper-and-the-first-fixtures-uncommitted)
- [ADR-0017 step 4: verify-events (uncommitted)](#adr-0017-step-4-verify-events-uncommitted)
- [Spike: DCB rule A at the type level (uncommitted, awaiting your decision on the API)](#spike-dcb-rule-a-at-the-type-level-uncommitted-awaiting-your-decision-on-the-api)
- [The change-impact report (DCB rule A, slice-friendly form) (uncommitted)](#the-change-impact-report-dcb-rule-a-slice-friendly-form-uncommitted)
- [Reasons in the impact baseline (uncommitted)](#reasons-in-the-impact-baseline-uncommitted)
- [completeFor removed (uncommitted; decision 2026-10-07)](#completefor-removed-uncommitted-decision-2026-10-07)
- [The plan document brought up to date again (2026-10-07)](#the-plan-document-brought-up-to-date-again-2026-10-07)
- [The docs note: two guides (uncommitted)](#the-docs-note-two-guides-uncommitted)
- [Decision: the 5 s leader retry is approved (2026-10-07)](#decision-the-5-s-leader-retry-is-approved-2026-10-07)
- [Plan step 6: storage visibility built; the tag table measured (uncommitted; decision pending)](#plan-step-6-storage-visibility-built-the-tag-table-measured-uncommitted-decision-pending)
- [Correction to the E9 conclusion about the pollers (uncommitted)](#correction-to-the-e9-conclusion-about-the-pollers-uncommitted)
- [The poller check, and what it changed (uncommitted)](#the-poller-check-and-what-it-changed-uncommitted)
- [Migration V11: the slim tag-key table (built, approved 2026-10-07; uncommitted)](#migration-v11-the-slim-tag-key-table-built-approved-2026-10-07-uncommitted)
- [Snapshots dropped (2026-10-07; uncommitted)](#snapshots-dropped-2026-10-07-uncommitted)

</details>

**Architectural decisions** made across all phases now live in [`docs/adr/`](docs/adr/README.md),
one file per decision. This file stays the phase-by-phase journal: status, gotchas, bugs found,
and what changed vs. each phase's plan. Early entries (Phase 0 - 3) refer to the predecessor
the framework started from; that is historical. Nothing in the code or API follows it any more (ADR-0010).

## Runtime: Bun + Node hybrid, not Bun-only

`@testcontainers/postgresql` hung indefinitely under Bun 1.3.11 (it did not reproduce on 1.4.2, but the suite is much slower under Bun; see the update in the ADR), so Testcontainers-backed tests run
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

## Live updates, phase 2: the feed endpoint (docs/plans/api-follow-ups.md item E)
- `GET /api/views/changes?views=a,b` (course app): server-sent events of `{view, transactionId, position}` (`ViewAdvanced`). One connection can watch several views (browsers cap HTTP/1.1 connections per origin); an unknown or empty `views` is a 400 problem. The definition (`api/CourseFeedApi.ts`) is browser-safe; `api/CourseFeedApiLive.ts` serves it. It is in the OpenAPI document (`text/event-stream`).
- `@crablet/views/ViewProgressFeed` (`viewProgressFeed(names)`): LISTEN on the progress channel (one dedicated connection per open feed, released when the stream ends), filtered to the named views. The stream OPENS with where each named view is now, read after the listener is confirmed, so nothing between is missed. That is also what makes the response start: with the `data` form of SSE Node sends the headers with the first chunk, so a feed with nothing to say would leave `fetch` waiting for them. (A view that has never advanced has no row, so such a feed's response starts with its first ping.)
- Each connection ends after a maximum lifetime (`maxFeedLifetime`, default 5 minutes); the page reconnects. No heartbeat frames in v1.
- Shutdown: `NodeHttpServer.layer(..., { gracefulShutdownTimeout })` (2 s in `index.ts`, 1 s in the test support) bounds how long stopping waits for open feeds. Closing the scope with a feed open reports an interrupt cause; the test support's `stop()` treats that as the expected end.
- Test: `test/integration/course-feed.test.ts` (opens with the current cursor; a ping covers the write's `(lastTransactionId, lastPosition)`; 400s; two connections independent; lifetime; quick stop with an open feed).

## Live updates, phase 3: the page (docs/plans/api-follow-ups.md item E)
- `main.ts`: Model `feed` (`connecting | live | reconnecting`), Messages `ReceivedSeatMapPing` / `LostSeatMapFeed`, and `subscriptions` (one `seatMapFeed` entry, registered in `entry.ts`). A ping reads the list's first page again under the filter in effect and, when a course is on show, that course; it never reads a course the user only typed. (A ping resets "More" pages to the first page - the simple choice; revisit if it annoys.)
- `api.ts`: `seatMapChanges()` (the derived client's SSE stream), `reconnecting(open, onPing, onLost, delay)` (forever; a connection that delivered then ended - the server's lifetime limit - reconnects after the base delay, a connection that delivered nothing counts up the backoff), `reconnectDelay` (0.5 s doubling, capped 30 s). Pings are debounced 150 ms in the subscription.
- Tests: `test/live.test.ts` (Stories for the Messages, a Scene with `Scene.Subscription.emit`, the backoff with fake connections) and the two-tab case in `page-against-server.test.ts` (the real subscription stream against the real server). Tutorial step 5 has a "Live updates" section. The Vite proxy already covers `/api`. Not verified in a real browser (no browser tooling here), and a production reverse proxy must not buffer the stream (`X-Accel-Buffering: no`/`proxy_buffering off`).

## Read consistency, phase 0: the wallet transaction list pages by keyset (docs/plans/read-consistency.md)
- `GET /api/wallets/:walletId/transactions` takes `limit` (default 20, at most 100) and `after` (the previous page's `next`) and answers `{ transactions, next }`. `page`/`size` and OFFSET are gone (breaking for that one endpoint; nothing in the repository used them). A bad `limit` or `after` is a 400 problem.
- Order and cursor are `(occurred_at, event_position, transaction_id)` descending. The view's key is `(transaction_id, event_position)` across all wallets, and a transfer writes two rows for one event, so `transaction_id` alone does not tell rows apart. The cursor (`src/api/TransactionPaging.ts`, base64url JSON) carries `occurred_at` as Postgres prints it (`occurred_at::text`), because a JavaScript Date keeps milliseconds and the column keeps microseconds; the decoder checks each part against what the SQL casts it to, so a forged cursor is a 400, never a Postgres error.
- `V104__wallet_transaction_view_page_index.sql` adds `(wallet_id, occurred_at DESC, event_position DESC, transaction_id DESC)` and drops V101's `(wallet_id, occurred_at DESC)` (its leading columns). Checked with EXPLAIN ANALYZE on 40,000 rows: an index-only scan with the row comparison as the index condition, no sort, 8 buffers for a page. Both hard-coded migration lists (`src/migrate.ts`, `test/support/applyAppMigrations.ts`) name the new file.
- Gotcha found by the test, not by reading: an output alias that reuses a column name wins in ORDER BY. `event_position::text AS event_position` made the rows sort as text ("9" before "11") while the WHERE (which sees columns, not aliases) compared numbers, so a page boundary would have repeated or skipped rows. The aliases are `occurred_at_text` and `event_position_text`.
- Tests: `test/transaction-paging.test.ts` (unit: limit and cursor) and `test/integration/transactions-paging.test.ts` (real Postgres: whole listing in order, ties on timestamp and event position, rows a microsecond apart, rows inserted between two requests, wallet isolation, empty list, default and maximum page size, 400s). Checked non-vacuous by truncating the cursor's timestamp to milliseconds: the microsecond test fails.

## Read consistency, phase 1: the write marker (docs/plans/read-consistency.md)
- The command response gains `marker`: `"<lastTransactionId>:<lastPosition>"`, a string on `CommandCreated` and `null` on `CommandIdempotent` (additive, ADR-0013). `?waitFor` and the `view` member are untouched until phase 6.
- The codec is `@crablet/eventstore/Marker` (`formatMarker`, `parseMarker`): both numbers canonical decimal (no sign, no leading zeros, no spaces), the transaction id kept as text (an xid8 does not fit a JavaScript number), and `parseMarker` returns null for anything the database could not hold (transaction id above 2^64 - 1, position above 2^63 - 1). It lives in `eventstore` because `commands-http` produces markers and cannot import `event-poller`, where `ProgressCursor` is.
- Spike result, the idempotent marker: not available without changes. `idempotentBy` is a boolean in SQL (`crablet_items_match_any`), and the `NoOp` decision carries no cursor. Both are written up in ADR-0015 and planned as phase 1b; until then a repeat's marker is `null`.
- Tests: `packages/eventstore/test/marker.test.ts` (round trip, one spelling, the bounds), the OpenAPI description test (marker required on created, null on idempotent), and the command API integration test (marker equals `lastTransactionId:lastPosition`, parses back, null on a repeat). Both OpenAPI documents and the tutorial's literal output regenerated.

## Read consistency, phase 2: what HttpApi supports (docs/plans/read-consistency.md)
- A throwaway server + derived client (removed after) answered the two questions ADR-0015 left open. Both work and both are documented in the generated OpenAPI: a success schema with an OPTIONAL header (`HttpApiSchema.WithHeaders(Body, { "crablet-consistency": Schema.optionalKey(Literal("stale")) })`, the handler returns `HttpApiSchema.withHeaders({ body, headers })`; an absent header is omitted), and a problem with a header (`encodeToWithHeaders` on the problem class, e.g. `retry-after`); one endpoint can declare a `404`, the shared `400` and the `503` together.
- The limit that changed the design: a response with headers cannot share its status and content type with another response, so two `503` problems (one with `Retry-After`, one without) are rejected when the endpoint is built. The failed view is therefore the same `503` problem with `reason: "view_failed"` and the header omitted (the header is `required: false` in the description).
- The cost: the derived client resolves a wrapped endpoint to `{ body, headers }`, not the body. The course page and the tests read `.body` (phase 5). ADR-0015 has the full "Spike result" section; the plan's phase 3 and 5 are updated.
- Gotcha for later: `Layer`/server tests that need the listening port read `yield* HttpServer.HttpServer` inside `Effect.gen` (there is no `.asEffect()` on the service in Effect 4.0.0).

## Read consistency, phase 3: `@crablet/views-http` (docs/plans/read-consistency.md)
- New workspace package `packages/views-http` (`bun install` links it; CI's globs and frozen lockfile need nothing else). Modules: `ReadConsistency` (pure `resolveReadPolicy`: API default, endpoint override, request parameters), `WaitForViews` (every view waited for at the same time with `waitUntilProcessed`, every outcome collected, a database error fails the wait), `HeadOfLog`, `ReadProblems` (ONE `ViewsUnavailable` 503 with `reason` and an optional `Retry-After`), `ReadQuery` (`consistencyQuery`, `ReadSuccess(Body)`, `readProblems`), `ConsistentRead` (the wrapper), plus `ReadConsistencyMetrics` in `metrics-otel`.
- The wrapper is `makeConsistentRead(options)(spec, run)`: `spec = { reads, parse, consistency? }`. `parse` is the endpoint's own validation and runs before any wait, so a bad `limit` is a 400 and never costs a timeout. Order: consistency parameters, `parse`, head of the log (also rejects a marker beyond it), the wait, then handler / 503 / stale header. A request that asks for a looser mode than the server allows, or a `waitTimeout` outside 1..max, is a 400 (not silently adjusted); the default `Retry-After` is 1 s.
- Tests: 28 policy cases (`read-consistency.test.ts`: every default x request mode combination, timeouts, markers), 7 for the wait (`wait-for-views.test.ts`: concurrency checked by a deadlock if sequential, every lagging view named, a failed view wins), 21 for the wrapper over fakes (`consistent-read.test.ts`), and 9 integration tests (`test/integration/consistent-read.test.ts`) over real Postgres with three views 0/200/400 ms behind behind a real `HttpApi`: marker and default `latest` wait for all three; strict timeout is a problem+json 503 with `retry-after: 1`; bounded returns 200 with `crablet-consistency: stale` and really stale data; eventual answers at once; bad requests are 400 without waiting; the OpenAPI description and the derived client (`{ body, headers }`, a decoded `ViewsUnavailable`); and `latest` while another connection holds a transaction open (503, then 200 once it ends). The wrapper's tests were checked non-vacuous by two mutations (no beyond-the-head check; breaking the bounded branch).
- Gotchas: the views package's `.` export is `ViewsModule` (`import { makeViewsProcessor } from "@crablet/views"`); a handler passed to `HttpApiBuilder.group` must not leak `SqlError` (declare it or `orDie` it); `HeadOfLog` aliases its columns `transaction_id_text` / `position_text`, for the ORDER BY alias reason recorded under phase 0.

## Read consistency, phase 4: the example apps' reads (docs/plans/read-consistency.md)
- Wrapped with `makeConsistentRead`: the wallet's `getWallet`, `getWalletTransactions`, `getWalletSummary` (each reads its own view's subscription) and the course app's `getCourse`, `listCourses` (`courseSeatsViewSubscription`). Each endpoint definition adds `...consistencyQuery`, `ReadSuccess(Body)` and `[..., ...readProblems]` (so the 400 and the 503 are declared); each handler keeps its own validation in `parse` so a bad `limit` or cursor is a 400 before any wait. Both OpenAPI documents regenerated (additive on the wire: new query parameters, the header on the 200, the 400 and 503 responses).
- Policy: the wallet uses the server default (`walletReadConsistency = defaultReadConsistency`: strict, `whenNoMarker: "latest"`, no loosening). The course app uses `whenNoMarker: "none"` and `clientMayRelax: true` (`courseReadConsistency`), a transitional choice recorded in ADR-0015: its existing demos and tests are about a stale unmarked read, and the page does not send markers until phase 5.
- Not additive for TypeScript clients, as the phase 2 spike predicted: a wrapped read resolves to `{ body, headers }` and its query is now required (`query: {}`). The course page's `api.ts` got the minimal change (`getCourse` passes `query: {}`, both reads return `.body`); sending the marker stays phase 5. The page's error mapper already turns the new 503 into a `Rejected` problem through its `title` branch. The wallet's derived-client test reads `wallet.body.balance` and checks `wallet.headers` is empty.
- Tutorial: the two tagged blocks that embed source (`CourseQueryApi.ts#query-api`, the UI's `api.ts#call`) were regenerated from their regions (`tutorial-sync.test.ts` fails until they match). The prose is untouched: it stays true for the course app (unmarked reads do not wait), and step 4 is rewritten in phase 6.
- Not built: the wallet "overview" endpoint the plan allowed for; the wrapper's tests (three views, a failed view, concurrency) and `consistent-read.test.ts` in views-http already cover a read of several views.
- Tests: `wallet-example-app/test/integration/read-consistency-e2e.test.ts` (8 wallets read straight after a write with no polling, even the first read of a new wallet; all three endpoints include the write; the command's marker sent with a read; unknown wallet still 404; `consistency=eventual|bounded` are 400s that say why; bad marker / marker beyond the log / bad timeout / bad limit are 400s; with another connection holding a transaction open a strict read is a 503 with `retry-after` naming `wallet-balance-view`, then 200 once it ends) and two new cases in `course-view-delay.test.ts` (an unmarked read is stale while the marked one waits, for both endpoints; `eventual`, `bounded` and strict with a short timeout; `latest`).

## Read consistency, phase 5: the Foldkit page sends the marker (docs/plans/read-consistency.md)
- A write no longer waits for anything: the page's commands (`DefineCourse`, `SubscribeStudent`) take no `waitForView`, and `CommandOutcome` is `{ status, reason, marker }` (the `view` member and the page's use of `ViewWaitResult` are gone). The read-back after a write (`readBack` in `update`) sends `consistentWith=<marker>` on both `FetchCourse` and `FetchCourses` when the checkbox is on (default), and nothing when it is off or when the write appended nothing. `FetchCourse` and `FetchCourses` carry `consistentWith: string | null`; every other read (a ping, a filter, More, a click, a lookup) sends none.
- The checkbox `waitForView` / `ToggledWaitForView` became `readWithMarker` / `ToggledReadWithMarker` ("Read back with my write's marker"). `viewNote(outcome)` became `readBackNote(readBack)`, and the result of a write records HOW it was read back (`readBack`: `with_marker`, `without_marker`, `no_marker`) at write time, so the note stays true if the box is toggled afterwards. A repeat has no marker, so it reads back without one and the page says so (until phase 1b gives repeats a marker).
- A strict `503` from a read is its own Problem, `SeatMapBehind { failed }` ("has not caught up with your write yet, try again" / "is not updating"), recognised by the response's `reason` and `views`, ahead of the generic `title` branch that would have shown it as "Rejected".
- Tests: `page.test.ts` rewritten around the marker (the marker on both read-backs, none when the box is off, none for a repeat, a ping reads unmarked, the notes, `SeatMapBehind`, the scene that tells the user which read was made); `page-against-server.test.ts` against the real server (with the marker the read-back is right and really waits, without it it is stale; a repeat has no marker; and a real 503, produced by holding another transaction open so the seat map cannot move, arrives through the derived client as `SeatMapBehind` after the server's 5 s default - that test takes about 10 s because the course and the list are each read back). The UI package got `pg` as a dev dependency for that test. `vite build` still works.
- Tutorial: step 5's prose and its four embedded blocks (`api.ts#call`, `api.ts#problems`, `main.ts#command`, `main.ts#read-back-note`, renamed from `view-note`) follow the page. Step 4 (the `curl` walkthrough with `?waitFor`) is untouched until phase 6.
- The course app's own policy is still `whenNoMarker: "none"` (phase 4): the page now sends markers, but a lookup typed by the user carries none and stays an unmarked read. Whether the course app moves to the server default (`latest`) is the phase 6 decision, together with the tutorial rewrite.

## Read consistency, phase 6: `?waitFor` is gone; the course app reads at `latest` (BREAKING; docs/plans/read-consistency.md)
- Removed from `commands-http`: `ViewWaiter.ts` (and its `package.json` export), `CommandApiConfig.viewWaiters`, `waitQuery`, the `waitableViews` option of `makeCommandApiGroup` / `makeCommandApi`, `ViewWaitResult` and the `view` member of `CommandCreated` / `CommandIdempotent`, and the wait branch of `CommandApiLive`. A command route now has no query parameters, so its derived-client call takes `{ payload }` only (no `query: {}`); a leftover `?waitFor=` / `?waitTimeout=` from an older client is ignored (no wait, no `view`, no 400), pinned by a test. Both apps lost `courseViewWaiters` / `walletViewWaiters`; `ViewWaitResult` is no longer exported from `CourseApi`.
- Policy: the course app moved from `whenNoMarker: "none"` (phase 4) to the server default (`courseReadConsistency = { ...defaultReadConsistency, clientMayRelax: true }`): a read with no marker waits for the head of the log. Consequences handled in the same commit: an unmarked read is no longer a way to show a stale answer, so `course-view-delay.test.ts` asks for `?consistency=eventual` to see one (and shows the default and a marked read are right, with a check that the default really waited); the feed test polls with `?consistency=eventual`; the page's unticked checkbox now asks the server not to wait (`consistency=eventual`, a new optional `eventual` argument of `FetchCourse` / `FetchCourses`) instead of sending nothing; a write that appended nothing (a repeat, no marker) reads back with `consistentWith=latest`. `ReadBack` is now `with_marker | latest | eventual`.
- Tutorial: step 4 rewritten around write, marker, read (the `wait-for` block is replaced by the `read-consistency` region of `CourseQueryApiLive.ts`; the curl outputs have no `view` member; the cases to know are the marker, `eventual`/`bounded`, the strict 503, a repeat's null marker and a bad marker's 400). The literal outputs were checked against a running server (same bodies, key order and 400 detail; only the ids differ). Intro bullet 4 and step 5's wording for the unticked checkbox follow. Embedded blocks regenerated.
- Docs: README (two lines), ADR-0011 (the read-your-writes bullet and the `waitFor` aside), ADR-0012 and ADR-0014 (one-line notes), a one-line pointer at the top of the four older plans that mention `waitFor`, both OpenAPI documents regenerated (the command routes lose `waitFor` / `waitTimeout` and `view`), ADR-0015 is **Accepted**.
- Not done (own pieces of work): phase 1b (a marker on idempotent repeats), phase 7 (measure `latest` at read rates and the poll cost), the shared per-instance listener for the wait, and the leader-fencing and event-versioning items from the architecture review.

## Read consistency, phase 7: what a consistent read costs (docs/plans/read-consistency.md)
- `examples/course-enrolment-app/scripts/bench-reads.ts` (`bun run bench:reads`, or `node scripts/bench-reads.ts [--seconds 4] [--pool 10] [--events 2000000] [--only 1,2,3,4]`, needs Docker) starts the real course app on a throwaway Postgres and measures four things. Everything ran on one laptop (8 cores, arm64, Docker Postgres 18, Node 25) with the load generator, the app and the database sharing it, a pool of 10 connections and ONE view per read: the numbers compare modes with each other, they are not capacity figures. Scenario 1 was run twice and agreed within about 10 %.
- **1. An idle log** (the view is caught up, so a wait returns at once; `eventual` = no wait, `latest` = the server default, `marker` = a write's marker):

  | conc | eventual reads/s | latest reads/s | marker reads/s | eventual p50/p95 ms | latest p50/p95 ms |
  |---|---|---|---|---|---|
  | 1 | 1,799-1,840 | 852-920 | 860-957 | 0.48 / 0.93 | 1.02 / 1.88 |
  | 8 | 5,102-5,825 | 3,103-3,280 | 3,137-3,269 | 1.17 / 2.85 | 2.11 / 4.82 |
  | 32 | 5,863-5,940 | 3,208-3,419 | 3,289-3,491 | 2.17 / 22.3 | 6.47 / 28.4 |

  A `latest` or marker read costs about two more queries than an `eventual` one (the head of the log, or the marker check, plus one progress query per view; about 3 database transactions per read against about 1), which is roughly half the throughput on one connection pool and about half a millisecond at p50 when the database is on localhost. Each extra query is a round trip, so on a real network the overhead is about two round trips; folding the head query and the progress queries into one statement would cut it to one (not built). `latest` and a marker cost the same.
- **2. Under writes** (one writer, about 25 subscriptions/s to one course, 16 readers of it): `eventual` 4,520-5,608 reads/s, p50 2.2-2.7 ms, p95 6.3-7.5, p99 12-14; `latest` 1,010-1,022 reads/s, p50 6.4, **p95 36.5-37.0, p99 42-44**. The p95 sits about one poll interval (25 ms) above the p50: a read that arrives while the view is even slightly behind sleeps one `waitUntilProcessed` interval before it looks again, so 25 ms is a latency floor for that read however fast the view catches up.
- **3. Waiters** (the seats view lags 400 ms; one write, then N readers ask for its marker at once; an unrelated `eventual` reader runs alongside):

  | pool | N | p50 ms | p95 ms | peak connections | unrelated reader p95 ms |
  |---|---|---|---|---|---|
  | 10 | 1 | 431 | 431 | 5 | 0.8 |
  | 10 | 10 | 510 | 513 | 11 | 1.2 |
  | 10 | 50 | 616 | 628 | 10 | 1.1 |
  | 10 | 200 | 1,108 | 1,133 | 10 | 3.5 |
  | 30 | 50 | 603 | 615 | 30 | 1.0 |
  | 30 | 200 | 1,005 | 1,048 | 30 | 1.2 |

  A waiting reader polls every 25 ms with up to two queries (its view's progress, and while behind a check for pending events), so it costs up to about 80 queries/s while it waits: the database counter showed about 800 transactions/s for 10 waiters and about 2,300/s for 50 (the N = 200 counter is not reliable: the pool is the limit there). Nothing failed. Past about 50 waiting readers on a pool of 10 the pool is full and the wait stretches (about +200 ms at 50, about +700 ms at 200 over the 400 ms the view lags); a pool of 30 did not help at 200 (the database is the limit), and an unrelated read stayed fast (p95 at most 3.5 ms against 0.9 idle). So the wait scales with the number of waiting readers times the poll rate, not with the pool.
- **4. The head-of-log query on 2,000,000 events:** an index-only backward scan of `(transaction_id, position)`, 4 buffers, 0.02-0.03 ms of execution (p50 0.27-0.29 ms including the round trip, p99 1.3-1.7 ms). It does not show up.
- Decisions the numbers support (ADR-0015, "Measured costs"): no cache of the head of the log (not built); the polling wait is fine for dozens of concurrent waiting readers per instance and is the next thing to replace beyond that, by waiting on the progress ping that views already send after each commit (ADR-0014) through one LISTEN per instance - the same shared listener that would remove the one-connection-per-open-page limit of the live feed. Not built; it is its own piece of work.
- Method notes: the first run of scenario 3 was discarded because the script read the database counter (which sleeps) AFTER the write, so the view had caught up before the readers started (the median was below the view's delay, which gave it away); the counter is now read before the write. Scenario 2's first run showed 46 non-200 responses on the `eventual` reads (404s before the view had the course); the script now waits until the view has it, and the statuses are printed.

## Shared listener, phase 1: `ViewProgressHub` (ADR-0016, docs/plans/shared-listener.md)
- ADR-0016 (Proposed) and the plan are written; the motivation is the phase 7 measurements (a pooled connection per open live page; a 25 ms poll and up to about 80 queries/s per waiting reader). Checked in Effect 4.0.0's `PgConnection.ts`: `listen` reserves a pooled connection until its scope closes, and after `LISTEN` is confirmed a connection failure FAILS the notification queue with the `SqlError` (the old comment in `Listen.ts` saying there is no signal on a drop is about the poller's own listener and was written before this was checked; that listener is unchanged).
- `@crablet/views/ViewProgressHub` (`ViewProgressHub` service, `makeViewProgressHub({ source, retryBase, retryMax })`, `ViewProgressHubLive` over `PgClient`): ONE `LISTEN crablet_view_progress` for the life of the layer; each subscriber (`subscribe(views | null)`, scoped) keeps the LATEST ping per view it asked for plus a `resync` flag and a latch, and `next` waits until it has something (never an empty batch). A sliding queue was rejected because a burst for one view could push another view's only ping out. Connection loop: listen, mark connected, flag every subscriber `resync` (the first connect included), pass pings on until the queue fails, mark disconnected, back off (0.5 s doubling to 30 s; back to 0.5 s after a connection that had been established), repeat. An undecodable payload is dropped. A subscriber that joins an already-connected hub gets no resync of its own: it reads the state after subscribing (the feed already does, a wait checks first).
- The source is a parameter so the unit tests drive it with a fake queue they can fail. Tests: 11 unit tests (delivery and filtering, a burst coalesced to the newest ping without losing another view's, `next` blocks, bad payloads dropped, resync on first connect and on every reconnect, a connection lost twice, retries with backoff, a subscription ends with its scope, 300 subscribers wake exactly the right 100); checked non-vacuous by two mutations (no resync on connect; coalescing by position instead of by view). 3 integration tests on real Postgres: a ping from `pg_notify` reaches only the right subscriber; 300 subscribers hold exactly ONE `LISTEN` session (`pg_stat_activity`); terminating that backend with `pg_terminate_backend` is followed by a reconnect in about half a second, a resync for every subscriber, one new `LISTEN` session, and pings flowing again.
- Not yet used by anything: phase 2 puts `waitUntilProcessed` on it, phase 3 the feed.

## Shared listener, phase 2: `waitUntilProcessed` waits on the hub (ADR-0016, docs/plans/shared-listener.md)
- With a `ViewProgressHub` in the context (`Effect.serviceOption`, so the signature and R are unchanged), `waitUntilProcessed` subscribes to the view's pings BEFORE its first look at the progress row (a ping that arrives meanwhile is already waiting), then loops: look; if it has the write (or nothing relevant is pending), return; if FAILED or out of time, fail; otherwise wait for a ping, a reconnect of the hub (a resync), `safetyInterval` (new option, default 1 s: the net for a lost ping) or the deadline, whichever is first, and look again. With no hub, or while the hub's LISTEN is down (`connected` is false), it polls every `interval` exactly as before, so tools and tests that build no hub are unaffected and a hub outage degrades to the old behavior.
- Tests (`packages/views/test/integration/wait-until-processed-hub.test.ts`, real Postgres; the view's progress is moved by SQL and the pings go through a hub over a source the test controls, so the timings are the wait's own): it returns within about 250 ms of the ping with a 2 s poll interval and a 10 s safety interval; **8 queries over a 1.5 s wait against 102 when polling** (about 13 times fewer); pings for other views do not make it look again; a lost ping is found at the next safety check; a hub reconnect makes it look at once (woken by the reconnect, not by a 30 s safety interval); a FAILED view is reported on the next look; the timeout and `reached` are unchanged; with nothing to wait for it returns at once; without a hub and with a hub that is not connected it polls. Checked non-vacuous by making the wait always sleep `interval` (the timing test then takes 2 s and fails). The existing `waitUntilProcessed`, views, views-http, wallet read-consistency and course delay suites pass unchanged.
- Not yet wired: no app builds a hub, so nothing waits on one in production code until phase 3 provides `ViewProgressHubLive` in the apps' layers.

## Shared listener, phase 3: the feed and the apps on the hub (BREAKING for `viewProgressFeed` and the apps' layers; ADR-0016, docs/plans/shared-listener.md)
- `viewProgressFeed(names)` is now a subscription to the `ViewProgressHub` (it requires `ViewProgressHub | SqlClient`, no longer `PgClient`): it subscribes first, then reads the views' current cursors and emits them, then emits the pings of the named views as batches arrive; a batch that carries a resync is answered with the cursors read from the table (they cover every ping in the batch, which arrived before the read). It holds no database connection.
- `makeCourseApiLayer` provides ONE `ViewProgressHubLive` to both the feed group and the query group (the same layer value, built once per build), so the feed and the reads' wait (`waitUntilProcessed` finds the hub with `Effect.serviceOption` inside the handler) share the one `LISTEN`; `makeWalletApiLayer` provides it to the wallet's query group, so the wallet's reads wait on pings too. The API layers now need `PgClient` (the apps' runtimes already have it). `CourseFeedApiLive`'s requirement is `ViewProgressHub | SqlClient`.
- Tests: `view-progress-feed.test.ts` in views (4 tests, real Postgres, a hub over a source the test controls: the opening cursors, only the named views' pings, the table read on a reconnect after the view moved with no ping, a feed opened before the hub connected). In the course app (`course-feed.test.ts`): **200 open feeds hold exactly ONE `LISTEN crablet_view_progress` session and at most 12 database sessions in all (the pool is 10), all open and get their opening frame, and one write gives every one of them a covering ping** (about 2 s for the whole test); and terminating the hub's backend with `pg_terminate_backend` is followed by every open feed saying where the view is again, and a later write still reaching them. Checked discriminating: with the old per-feed `LISTEN` put back, the 200-feed test hangs until its 90 s timeout (the pool runs out; later feeds cannot even connect). All other course, wallet, page, views and views-http suites pass unchanged.
- Docs: ADR-0014's "one LISTEN per open feed" consequence is struck through and points to ADR-0016 (Accepted); the comment in `Listen.ts` says the poller's own listener still has no reconnect and names the hub as the model.
- Next: phase 4 re-runs `bench-reads.ts` (the 25 ms floor under writes, many waiting readers) and updates the measured numbers and the scale envelope's live-pages limit.

## Shared listener, phase 4: measured, and what the measurements corrected (ADR-0016, docs/plans/shared-listener.md)
- `bench-reads.ts` now runs scenarios 1-3 and a new 6 (read your own write) twice, with the wait polling (`CourseAppConfig.viewProgressHub` replaced by a hub that is never connected) and with the real hub, in one session, plus 5 (database sessions held by N open feeds). Results are in ADR-0016 "Measured results"; the headline numbers: read-your-own-write p50 30.7 ms to 14.7 ms (three runs, stable); `latest` reads under writes +36 % to +96 % throughput; waiting readers about 3 times fewer queries; 1,000 open feeds hold 5 database sessions in all (4 + the hub's LISTEN).
- A change came out of it: with the hub, waiters woken by one ping all ran their own check at the same instant (a thundering herd, visible as no latency gain at 200 waiters and a worse run). The ping carries the view's cursor and is sent in the same statement that moves the progress, so a ping whose cursor covers the write now ends the wait WITHOUT another query; a ping that does not cover it, a resync and the safety interval still look at the table. Two new tests: a covering ping ends the wait with no query even though the table was not moved (the ping is the answer), and a ping older than the write makes it look.
- Corrections to what phase 7 recorded (ADR-0015 "Measured costs" is edited in place): (1) the "about 80 queries/s per waiting reader" had been read off the database's transaction counter in scenario 3, which also counted the unrelated probe reader's own ~1,200 reads/s, so it did not show it; the figure now rests on a direct count (one polling waiter: 102 queries in 1.5 s, about 68/s, against 8 with the hub) and the probe is paced. (2) The "25 ms floor" is better described as "a polling wait adds about half a poll interval on average": with the hub a read-your-own-write still takes ~15 ms because the view itself needs that long to apply a write. (3) "Unrelated reads stayed fast during a burst of waiters" was an artifact of a probe looping flat out (most of its thousands of reads fell outside the burst): with a paced probe an unrelated read is delayed by about a second during a 200-waiter burst, with polling or with the hub. The stretch under a burst is not caused by polling.
- Not improved, and said so: the p99 of `latest` under writes was not better with the hub (worse in two of three runs; the machine was loaded, the cause is not understood), and a burst of simultaneous waiters is not reduced. Method notes: the later runs shared the machine with other work (load average about 8 on 8 cores), one scenario-3 run was cut off by the 10-minute limit, so ranges over several runs are quoted instead of single numbers.
- Open: bound the number of reads waiting at once per instance, or give waits a pool separate from the one the view's batch needs; the poller's own wake-up listener (`crablet_events`) still has no reconnect.

## Shared listener, phase 4 follow-up: the "stampede" was the benchmark, not the server (corrects the entries above)
- Asked to fix the two items phase 4 listed as not improved (a burst of simultaneous waiters, and the p99 under writes), I first looked for the cause instead of building a limit. In a 200-waiter burst the view's own progress ping arrived at about 1,000 ms instead of about 500 ms, and a CPU profile showed the process mostly idle with its largest cost `internalConnectMultiple` (about 590 ms): the load generator opening 200 NEW TCP connections. The app, the view's batch and the load generator share ONE event loop, so that cost delayed the view's batch and therefore every waiter. Run twice in one process, the same 200-waiter burst took p50 1,056 ms cold and 534-548 ms warm (the view's ping at 1,000 ms and 490-508 ms). The earlier "plain" control only looked fast because it ran after the waiter burst and reused its sockets. So there is no server problem to fix there, and nothing was changed in the server for it.
- What was wrong was my write-up. ADR-0015 ("Measured costs") and ADR-0016 ("Measured results") are edited in place: the "+200 ms at 50 waiters, +500-800 ms at 200", "not caused by polling", "unrelated reads stayed fast" (a flat-out probe hid the burst) and "a burst of simultaneous waiters is not reduced" statements are replaced by the warm measurements. The benchmark's scenario 3 now warms the N connections first (the N warm-up reads are subtracted from the transaction count).
- Warm scenario 3 (one run): waiters finish at the view's own time with either wait (200 at once: p50 474 ms polling, 505 ms hub, for a 400 ms lag); the hub issues 2.4 times fewer queries at 10 waiters and about 9 times fewer at 50 and 200 (304 against 33 transactions/s at 200), and an unrelated read's p95 at 200 waiters is 7.3 ms with the hub against 49.3 ms polling.
- The p99 of `latest` under writes stays inconclusive: even the baseline's p99 varied 3 times between runs on a loaded machine, so it is not evidence either way. Nothing was fixed for it because nothing is known to be broken.
- The lesson, twice now in this work: a number from this benchmark is only as good as its control. Both mistakes (the transaction counter swamped by the probe; cold sockets) were found by a figure that did not fit the expectation (a median below the view's delay; a ping arriving twice as late), not by review.

## Reliability and scale: diagnostic and plan (docs/plans/reliability-and-scale-diagnostic.md)
- Asked to fix "the most important issues", the work was reordered at your request: measure first, then plan, no fixes. Real-Postgres experiments (kept as `packages/event-poller/diagnostics/leader-and-listener.diagnostic.ts` and `packages/commands/diagnostics/boundary-and-storage.diagnostic.ts`, outside the test globs) found: a leader whose database session is killed keeps handling events (723 calls in 40 s) and 32 % of events are handled by two instances once the other takes over; the cursor can be written backwards (900 then 100 reads 100); failover after a leader process dies is uniform in (0, retry interval] (measured at 5 s; derived for the apps' 30 s: mean about 15 s); a killed `crablet_events` listener turns a 51 ms write-to-view into 7.7 s and is never re-established (D3b: the LISTEN session count stays 0 for 30 s); a strict command costs 190 ms at 100,000 events in its boundary and 1.1 s at 500,000 (the append stays 1 ms); one event in an old payload shape makes every command on its boundary fail with a defect; an event costs 476 bytes on disk.
- The plan (ordered): leadership that tells the truth plus a fence plus a forward-only cursor; a reconnecting wake-up listener; faster failover; profile then design snapshots; an event-evolution policy; storage visibility. Three decisions are asked of you at the end of the document. No product code has changed.

## Plan step 1: truthful leadership, a fence and a forward-only cursor (done, uncommitted)
- `tryAcquireGlobalLeader` now runs a heartbeat on the leader's reserved connection and exposes `verify`. `isLeader()` turns false after `failuresBeforeLost` (2) consecutive failed checks, and the lost handle releases its connection. `EventProcessor` calls `verify` before the handler and again before the cursor moves (a `LeadershipLost` that records no handler error), and its retry loop releases a lost handle before acquiring another. Both trackers (`PostgresProgressTracker`, `OutboxProgressTracker`) write the cursor forward only, so a late write moves nothing and sends no ping.
- A first version of the check (`SELECT 1`) did not fix D1: the killed session's pooled connection came back on a new session that answered queries, so the heartbeat failed once and then passed (measured with a temporary log). The check now asks `pg_locks` whether THIS session still holds the advisory lock. Lesson: test the property (holds the lock), not a proxy (answers a query).
- Re-run of the experiments (one run each): D1 handler calls by the old leader after the kill 723 -> 0; events handled by both instances after the kill 232 -> 0; takeover still +27.1 s (step 3); D2 cursor 900 then 100 reads 900 (was 100).
- Tests: leader-liveness (5, real Postgres), 4 fence/retry-loop unit tests, 3 tracker integration tests. Not covered: an outbox-specific forward-only test (same SQL shape; the outbox integration suite passes).

## Plan step 2: a wake-up listener that reconnects (done, uncommitted)
- `wakeupStream` (the pollers' `LISTEN crablet_events`) is now built from `wakeupStreamFrom(listen, { retryBase, retryMax })`: it never ends or fails; when the connection is lost or cannot be made it waits (500 ms doubling to 30 s, back to 500 ms after a connection that was up) and listens again, and after every RE-connect it emits one wildcard wakeup, because notifications sent while it was away are gone. The first connect announces nothing. Same pattern as the view progress hub (ADR-0016). `EventProcessor`'s dispatcher also restarts the drain (after 1 s) if a stream ends or fails anyway.
- Re-run (one run each): D3 write -> handled after 25 s idle with the listener session killed 7,695 ms -> 78 ms (healthy 44 ms); D3b LISTEN sessions after the kill 1 -> 0 for 30 s -> stays 1.
- Tests: `listen-reconnect.test.ts` (unit, fake source: drop, failed retry, wildcard on reconnect, none on first connect) and a real-Postgres test that terminates the LISTEN backend.

## Plan step 3: faster failover (done, uncommitted)
- The leader retry default is 5 s (was 30 s; `processorConfigOf`, the processor's fallback, and the two example apps). A follower tries `pg_try_advisory_lock` that often: one reserved pooled connection and one statement per module per instance every 5 s.
- A graceful release (`stop`) now unlocks and sends a wildcard `pg_notify` on `crablet_events` in ONE statement, so the notification is delivered after the unlock took effect. The processor's dispatcher turns a wildcard wakeup into a hint that ends the follower's retry sleep. No new connection: the followers already LISTEN on that channel. A wildcard also comes from an over-long payload or a listener reconnect; the cost is one extra try-lock. A session that died cannot announce, so after a crash followers wait for their timer.
- Measured (6 trials each, leader stopped at different phases of the follower's retry cycle): crash, retry 5 s: 4.2, 3.4, 2.6, 1.8, 1.0, 0.2 s (mean 2.2 s; was uniform in (0, 30 s), mean about 15 s derived); graceful stop: 0.04-0.10 s (mean 0.07 s). New diagnostic D1c.
- Tests: leader-liveness (release announces, a lost leader sends nothing), an event-processor unit test (a wildcard wakeup triggers an immediate attempt, an ordinary one does not). Integration suites of eventstore, event-poller, outbox, automations, views, views-http: 138/138.

## Plan step 4, part 1: where the boundary time goes (measured; no fix yet)
- New experiment E5b (`packages/commands/diagnostics/boundary-and-storage.diagnostic.ts`). At 100,000 events in one boundary: command 186 ms; loading the state 180 ms (97 %): the database's own execution 44 ms, driver plus network plus building the row objects about 109 ms, schema decode and fold about 26 ms; the append with its conflict check and everything else about 6 ms. So the conflict check is constant, decode/fold is small, and the cost is moving rows (the split is by subtraction of separate runs; approximate to a few ms). Details in docs/plans/reliability-and-scale-diagnostic.md (E5b, F4).
- Consequence for the design: only reading fewer rows helps (a snapshot or a cheaper row), not faster decoding. The ADR for snapshots is next; nothing is built.

## Plan step 4, part 2: ADR-0018 (snapshots), Proposed
- Before writing it, E5c: the read of "only the events after a cursor" is 0.5 ms with nothing newer in the log but 16 ms (database 14.7) when 400,000 events of other entities follow, because the planner then reads the whole entity through the GIN tags index. So a snapshot gives roughly 186 ms -> 7-25 ms at 100,000 events (derived), not a constant: the tail read stays linear in the entity's size until an index lets it seek.
- The ADR: opt-in per model (`name`, `version`, state `schema`, `every`); key = name + version + a hash of the boundary query; row holds state plus the settled cursor; load = snapshot + tail; fail open (a snapshot is a cache) against fail closed for events; written after the load, outside the command's transaction, forward-only; checked by a differential test and a `verify-snapshots` script.
- Found while reading `Model.ts`: `all(...)` (a transfer over two wallets) reads the whole UNION boundary just to get a position, so snapshots of its members would not help the hot multi-entity command; taking that position from the members' cursors is not obviously safe (min can fail for ever, max can skip). Left as an open point that needs its own analysis; nothing is built.

## ADR-0018 open point 1 resolved: the cursor of an `all(...)` model (analysis, proved by a test)
- Question: can an `all` model get its append-condition cursor without reading the whole union boundary? A condition is safe if every event a member's read missed sorts AFTER the cursor, and live if every event the members saw and that had settled sorts at or BEFORE it. A read sees everything with a transaction id below its snapshot's xmin and may miss anything at or above it.
- Three candidates tried on deterministic interleavings against real Postgres (`packages/eventstore/test/integration/union-boundary-cursor.test.ts`, 3 tests, all pass): max of the members' last settled events is UNSAFE (a lost conflict: B reads while a lower-xid transaction is uncommitted, it commits, A then reads a newer event, max sits above the missed one); min of the members' last events is NOT LIVE (refuses on every retry in a quiet database); the minimum of the members' read horizons `(xmin, 0)`, each taken by a statement run before the member's read, is safe and refuses exactly the events at or above the oldest xmin, which is what a single model refuses today (also when an unrelated old transaction pins xmin).
- Consequence: `all` can load its members independently (snapshot + tail, in parallel) and drop the union scan; `ProjectionResult`/`Loaded` gain a `horizon`. ADR-0018 now has this as decision 8 and can be built independently of snapshots (it also removes a full read from every `all` command today). Caveats recorded there: the horizon cursor has position 0, which `queryEvents` treats as "no cursor" (append condition only); a randomized executor-level concurrency test is still to be written. Nothing built yet.

## `all(...)` horizon built (ADR-0018 decision 8; uncommitted)
- `project` returns a `horizon` (Postgres: `(xmin of a snapshot taken just before the read, 0)`; in-memory: the end of the log); `Loaded` carries it; `all` loads its members one after another and uses the EARLIEST horizon as its cursor; the full read of the union boundary (`positionOnly`) is gone. `LogPosition.earliest` added. One extra trivial statement per `project` call. The in-memory `all` cursor is now the log head, so two model tests changed their expected position (and gained a test that the cursor stays at the earlier member's horizon when a write lands between member reads, and one that `all` reads each member's boundary once and nothing else).
- Measured (E5d): transfer with one 100,000-event account 403 -> 218 ms p50. Unit 506, integration 303 pass, typecheck clean.
- Honest limit: swapping in the unsafe max cursor did not fail the concurrent stress test in 3 runs; that hazard needs a specific interleaving. The deterministic SQL test is the proof; an executor-level deterministic test is still open.

## Executor-level test for the `all` cursor (closes the gap noted above; uncommitted)
- `packages/commands/test/integration/all-union-cursor-postgres.test.ts` forces the dangerous interleaving through the real `CommandExecutor` with a hook between the members' loads (`afterLoad`): X is read while a lower-xid transaction holds an uncommitted spend of 80 of X's 100; it commits; a newer event lands in Y's boundary; Y is read. With the horizon cursor: Conflict, reload, the domain refuses (X ends at 20). Mutation-checked: with the maximum of the members' last events as the cursor the test fails with "X was overspent (balance -60)", so unlike the random stress it does detect the unsafe cursor.
- `pg` added to the commands package's devDependencies (same version as eventstore's) for the test's own connections; the lockfile changed accordingly.

## Snapshot spike: how to write a snapshot when the load is inside the command's transaction (ADR-0018 open point 3; uncommitted)
- `packages/commands/diagnostics/snapshot-write-spike.diagnostic.ts`, real Postgres, one run per experiment. A: a statement can leave the ambient transaction (`Effect.updateContext(Context.omit(sql.transactionService))`): other backend, survives a rollback. B: doing that from inside a transaction deadlocks the pool as soon as concurrent commands reach the pool size (0/2 with pool 2, 0/4 with pool 4, 0/12 with pool 4 finished in 4 s). C: collecting the pending write in an ambient service and writing after `withTransaction` returned works at the same sizes (2/2, 12/12, and 12/12 even when every transaction fails; 146-364 ms for the batch).
- Decision recorded in ADR-0018 (point 3 resolved): the load records a pending write in a collector the executor provides; the executor flushes it after the transaction, inline with a short timeout, failure ignored. The state is valid whether the command committed or not.
- Side note for the tooling: Node's type stripping rejected a file with a missing paren with a confusing "Expected ',', got ';'" that pointed at the wrong line; `bun build --no-bundle` gave the exact one.

## Migration V9: crablet_model_snapshots (ADR-0018 implementation step 1; uncommitted)
- `packages/db-migrations/sql/V9__crablet_model_snapshots.sql`, registered in `migrationFiles`: table keyed `(name, version, fingerprint)` holding `(transaction_id xid8, position bigint, state jsonb, updated_at)` with length/sign checks, and `crablet_save_snapshot(...)` which inserts or replaces only when the new cursor is LATER in `(transaction_id, position)` order and returns whether it wrote. The forward-only rule lives in that one SQL function, not in TypeScript, so every writer gets it.
- Test: `packages/eventstore/test/integration/model-snapshots-schema.test.ts` (5 tests, real Postgres): columns/types/key, forward-only (equal and earlier cursors write nothing), order is (transaction_id, position) not position, name/version/fingerprint each make a different row, bad name/version rejected. Mutation-checked: flipping the comparison to `<=` fails the forward-only test. eventstore + commands + examples integration: 207/207 pass; typecheck clean.
- Next (ADR order): the `SnapshotStore` service and the collector, then load with snapshot + tail behind `.snapshot(...)`.

## SnapshotStore, canonical query and collector (ADR-0018 implementation step 1, second half; uncommitted)
- `packages/eventstore/src/SnapshotStore.ts` (exported as `@crablet/eventstore/SnapshotStore`): `SnapshotStore` service (`get`, forward-only `save` that says whether it wrote, `pruneOtherVersions`), `SnapshotStoreLive` over `SqlClient`, `canonicalQuery(query)` (order-insensitive text of a boundary query; a type and a tag cannot collide), `SnapshotCollector` + `SnapshotCollectorLive`, and `flushSnapshots`. The fingerprint is `sha256` computed BY THE DATABASE from the canonical text on both read and write, so the key has one definition and no Node `crypto` is needed (the module stays free of Node built-ins).
- The collector keeps one pending write per key (later cursor in (transaction_id, position) order wins); `flushSnapshots` drains it and writes one at a time with a 1 s timeout, ignoring every failure (logs a warning), to be called after the transaction ended (decision of the spike). The executor does not call it yet.
- `Crablet.layer` now also provides `SnapshotStore` (additive).
- Tests: 6 unit (canonical order-insensitivity and distinctness, later cursor wins, flush empties, a failing and a hanging save are ignored and the others still written) and 5 integration on real Postgres (round trip incl. a position above 2^53 and a large xid, forward-only with the boolean, key = name+version+query and reordering is the same key, prune). Unit 512, eventstore+commands+examples integration 212 pass, typecheck clean.
- Next: the load with snapshot + tail behind `.snapshot({ name, version, schema, every })`, failing open, with the differential test; then the executor flush.

## Load with snapshot + tail (ADR-0018 implementation step 2; uncommitted)
- `defineModel(...).snapshot({ name, version, schema, every? })` (chain it last). `ModelInstance.load` of a snapshotted model: read the stored row through `SnapshotStore` (if one is in the context), decode its state with the schema (a state that does not decode is ignored), read only the events after its cursor with the decoded state as the projector's initial state, and, when the load folded at least `every` events (default 1,000) and its cursor advanced, RECORD a pending write in the ambient `SnapshotCollector` (if there is one). No store in the context = the model loads as if it declared nothing. A database error from `get` is not swallowed (a missing V9 is a misconfiguration; a failed statement would also abort the command's transaction).
- Found while building it: a load folds events it saw but that are not settled into its state, while its cursor stays below them, so a snapshot of that state would double count them next time. `ProjectionResult` gained `settledState` (state as of `logPosition`); the snapshot stores that. Proved on real Postgres by pinning xmin with an older open transaction; mutation-checked (storing `state` instead fails that test).
- Helpers: `InMemorySnapshotStore` (`@crablet/eventstore/testing/InMemorySnapshotStore`) and `checkSnapshotEquivalence` (`@crablet/commands/testing/Snapshots`: random histories split at random points, load with snapshot, flush, compare with a reference model that has no snapshot; deterministic by seed). Metrics: `crablet.snapshot.loads` (outcome), `.folded_events`, `.writes` (written / not_newer / failed).
- Tests: 11 unit (no `.snapshot` never asks the store; write only at `every`; next load reads only the tail and equals the full fold; unchanged logPosition when there is no tail; other entity/version not used; undecodable state ignored; no store; no collector; `all` members; differential over 300 random histories; a fold changed without a version bump IS detected as different) and 3 on real Postgres (equivalence load after load; unsettled events not in the snapshot; undecodable row replaced). Mutation checks: reading from the start with the snapshot's state fails 4 unit tests; storing the unsettled state fails the Postgres test. Unit 523, eventstore+commands+examples integration 215, typecheck clean.
- NOT done yet: the executor does not provide the collector or call `flushSnapshots`, so no snapshot is written by commands yet; E5 has not been re-run (the 186 ms -> ~7-25 ms expectation is still only derived).

## Executor wiring and the E5 re-run (ADR-0018 implementation steps 3 and 4; uncommitted)
- `CommandExecutor`: each attempt creates a `SnapshotCollector`, provides it to the attempt (the transaction), and `Effect.ensuring` flushes it after the transaction ended, committed or failed (`flushCollected`: an empty drain when a model has no snapshot, a no-op without a `SnapshotStore` in the context, timeouts and ignored failures otherwise). The write is not from inside the transaction (spike: pool deadlock). `writeSnapshots` was split out of `flushSnapshots`.
- Tests (`snapshot-executor-postgres.test.ts`, real Postgres, 6): a command leaves a snapshot of the state it decided on; the next one reads only the tail and equals the full fold; a domain failure still leaves the snapshot; a plain model writes nothing; 8 concurrent commands on a pool of 2 all finish and all write; an executor built without a SnapshotStore works. Mutation-checked: flushing only on success fails the domain-failure test. Unit 523, integration 323, typecheck clean.
- E5e (the acceptance test, one run, 25 commands per cell): 100,000 events 185 ms -> 2.9 ms (best case) / **19.1 ms** with 200,000 other events written after the snapshot; 500,000 events 1,094 ms -> 3.0 ms / **26.2 ms**. The derived expectation (7-25 ms) held for the realistic column. The first command costs what an unsnapshotted one does. Recorded in ADR-0018 and the diagnostic (E5e, F4).
- Remaining for ADR-0018: `verify-snapshots`, the index question (the tail read still walks other entities' newer events), docs/tutorial note, and deciding the status (Proposed -> Accepted) after a review.

## verify-snapshots (ADR-0018 implementation step 5; uncommitted)
- Problem found first: the snapshot key is a hash of the boundary query, so a row cannot be turned back into a model instance (the fold's handlers can use `ctx.id`, and scope such as a year is not recoverable). Migration `V10__crablet_snapshot_entity.sql` adds `entity jsonb` (the model's `of(...)` arguments, e.g. `{"id":"w-1","year":2026}`) and a seven-argument `crablet_save_snapshot` (the six-argument call still works: `p_entity` defaults to null). Rows written before V10 have a null entity and are reported as unverifiable.
- `SnapshotStore` gained `list` (a random sample of a model's rows), `summary` (rows per name and version) and `fingerprint`; `PendingSnapshot` carries an optional `entity` (the load passes its `of` arguments); `ModelInstance.snapshot` exposes `{ name, version, schema }`.
- `verifySnapshots({ models: [{ name, instance }], sample?, attempts? })` -> report with `ok`; `formatSnapshotReport`. Per sampled row: stale boundary (fingerprint of the model's current query differs), undecodable state, then two loads of the instance (the second with a stub `SnapshotStore` that has nothing, so it folds the whole boundary) compared on state and position, reloaded up to `attempts` (3) times before reporting a mismatch (a concurrent command is not a bug). It never writes (no collector in the context). Rows of other versions and unregistered names are listed as unaccounted.
- Tests: 9 unit (clean; fold changed without a version bump -> mismatch with both states; version bump -> old rows unaccounted, none checked; changed boundary -> stale; undecodable; unverifiable does not fail; unaccounted names; sample limit; the retry on a racing append, and without the retry the same race IS reported), 2 on real Postgres (commands leave snapshots whose entity carries the scope `{id, year}`, they verify clean, a corrupted row is found as a mismatch for the right entity and the report shows the full fold's value) and the schema test for V10 (entity stored and replaced; six-argument call still works). Mutation-checked.
- Unit 532, typecheck clean. Integration: 326/326 with `--test-concurrency=4`. With the default concurrency two full runs failed (9 tests, then 1 file) with a 60 s suite timeout and the children "cancelled": the `startTestDb` hook did not finish while ~30 Postgres containers started at once on this machine; `command-run.test.ts` passed 3 of 3 alone and the full run passed at concurrency 4. Not fixed (it is machine load, not code); `bun run test:integration` may need a concurrency cap on small machines.

## Decisions taken (2026-10-06, following the recommendation)
- ADR-0018 (snapshots) is Accepted, with four follow-ups left open (the tail-read index, tuning `every`, `version` for generated models, a tutorial/README note). ADR-0017 (event evolution) stays Proposed until a spike shows how to write a decoding default in Effect Schema 4.0.0.
- `test:integration` now runs `node --test --test-concurrency=4`: with the default concurrency two full runs on this machine failed with 60 s `startTestDb` timeouts while about 30 Postgres containers started at once, and the full run passed (326/326) at 4. Not measured on CI (its runner is a different machine); if it is slow there, raise the number.

## The plan document brought up to date (uncommitted)
- `docs/plans/reliability-and-scale-diagnostic.md` described the project before any fix ("nothing has been fixed"). Now: a status line, a per-step Status column with commits and what is left, a "Results of the fixes" table (before/after of every experiment), the corrected D4 (the conclusion that a successful query on the leader's connection proves the lock was wrong; see the step 1 entry), an updated "what I did not measure", the step 1 design marked as built with the fence's residual (a zombie can still do one batch), and a Decisions section split into resolved and open (the 5 s retry and wake-on-release are still not explicitly approved; ADR-0017 stays Proposed pending the Effect Schema decoding-default spike).
- Corrections made while updating: the step 2 "reconnect counter" was never built (a reconnect leaves no metric or log); the D1b before/after row had identical numbers because D1b always ran with an explicit 5 s retry, so it now says what changed (the default, derived 30 s mean 15 s to measured 5 s mean 2.2 s) and what did not (a crash cannot announce itself).

## ADR-0017 spike: the decoding default exists and the policy is implementable (uncommitted)
- The earlier "failed attempts" were my misuse. In Effect 4.0.0: `Schema.Number.pipe(Schema.withDecodingDefaultKey(Effect.succeed(0)))` in a `Schema.Struct`; absent key -> default, wrong type or `null` -> error; decoded type has the field required; new events must carry it (omitting is a compile error); `Schema.optionalKey` for fields with no sensible default. Unknown keys are ignored (tolerant both ways). `personal(...)` is found on optional and defaulted fields.
- A decode failure is a `SchemaError`; `SchemaIssue.makeFormatterStandardSchemaV1()` gives `{ path, message }` entries, `{ errors: "all" }` reports every problem (default: the first only), and the default messages do not echo the offending value (checked), so issues can be logged.
- Prototype of the fixture check (payload + stored tags, decode with the current definition, derive tags, compare): passes a compatible change, catches a tag derived from a defaulted field (old events do not carry it: DCB rule B), catches a rename or a new required field.
- 17 tests in `packages/commands/test/event-evolution.test.ts`; typecheck clean. ADR-0017's open points are updated (point 1 resolved; point 2 has a recommended design: `decode` throws a small `EventDecodingFailure`, `project` turns it into a typed `EventDecodingError` with position, transaction id, type and issues). ADR-0017 stays Proposed.

## ADR-0017 accepted; step 1: the typed EventDecodingError (uncommitted)
- ADR-0017 is Accepted (you approved it, 2026-10-06). Built in the ADR's order, each step on its own.
- Step 1: `packages/eventstore/src/EventDecoding.ts` (`EventDecodingFailure` thrown by a definition's `decode`, with `eventType` and `issues: { path, message }[]`; `EventDecodingError` typed failure with `type`, `position`, `transactionId`, `issues`; `decodingErrorOf`). `defineEvent.decode` decodes with `errors: "all"` and rethrows anything that is not a schema failure. `EventStore.project` and the in-memory store catch the failure around `transition` and fail with the typed error (the loop is the only place that knows the position and transaction), log it once, and count `crablet.eventstore.decoding_failures` by `event_type`. `exists` keeps its `SqlError` type (its projector never decodes). `Model.load`'s error is `SqlError | EventDecodingError`; `commands-http`'s `Presentable` includes it and it surfaces as the generic 500 (no event name in the body); the wallet example's `resolveActivePeriod` signature gained it.
- Tests: model.test (typed failure with position, transaction, type and issues, not a defect, same on every attempt, no payload value in the message), event-evolution (the failure's shape; nested paths keep numbers; messages do not echo values), a real-Postgres test through the executor (typed, repeated, other entities unaffected) and an HTTP test (500, the same again, nothing about the event in the body, another entity 201). Mutation-checked: letting the failure propagate raw fails the Postgres test. E7 diagnostic re-run shows the named error. Unit 549, integration 328 (default concurrency now 4), typecheck clean.
- Found on the way: Node's type stripping (which runs the shipped sources) rejects TypeScript constructor parameter properties (`constructor(readonly x: ...)`), the integration run failed with a syntax error until the fields were written out. Avoid them in `src/`.
- Next: step 2, decode through the definitions in every reader (the wallet's projectors and automation cast today), then the fixtures helper, `verify-events`, the DCB rule A check, and a note in the tutorial and README.

## ADR-0017 step 2: every reader decodes through its definition (uncommitted)
- New on every event definition: `decodeStored(event)` (`Effect<Data, EventDecodingError>`; takes anything with `data`, `position` and `transactionId`). It shares `reportDecodingError` (log once with position, transaction, type and issues, count `crablet.eventstore.decoding_failures`, fail) with `EventStore.project`. A processor records a typed handler failure against the processor (`recordError`, then FAILED after `maxErrors`), which a throwing `decode` inside a projector would not have been (a defect skips `recordError`; the tick only logs it).
- Converted: the wallet's four view projectors (balance, transaction, summary, statement; decode first in each handler, so an unreadable event is refused even when the handler would have ignored it), its welcome automation (its error channel is now `EventDecodingError`) and the course app's projector (the tutorial snippet regenerated from the region; its sync test passes). Before, the wallet readers cast `event.data` and validated nothing. The outbox publishers do not read payloads. A view batch is one transaction, so an unreadable event rolls back the good events of its batch.
- Tests: 3 unit (`decodeStored`: default applied, typed failure with position/transaction/type/issues and not a defect, lazy), a real-Postgres test over balance, transaction and summary views (typed error naming the DepositMade, a good WalletOpened in the same batch left no row), 2 unit for the automation. Mutation-checked: a projector that casts again fails the Postgres test. All the existing wallet and course tests passed unchanged under the stricter reading (their fixtures were complete). Unit 554, integration 329, typecheck clean.
- Next: the fixtures helper (payloads each event type was once written with, plus the tags they were stored with; the prototype is in event-evolution.test.ts), then `verify-events`, the DCB rule A check, a docs note.

## ADR-0017 step 3: the fixtures helper and the first fixtures (uncommitted)
- `@crablet/commands/testing/EventFixtures`: for each fixture (the payload an event type was once written with and the tags stored with it) the CURRENT definition must decode it (`undecodable`, with paths), derive no tag the stored event lacks (`invented_tag`: a boundary on it would miss the old event, DCB rule B) and lose none that was stored (`lost_tag`); an event type the log holds but the code no longer defines is `no_definition`; `requireCoverage` also fails event types with no fixture. `scopeTags` names the keys of tags that come from `extraTags` (the wallet's period tags), allowed to be stored without being derived. `fixtureOf(storedEvent)` captures a fixture from an event; `loadEventFixtures(dir)` reads a directory of JSON (Node only, test tooling). The spike's prototype in event-evolution.test.ts was replaced by it.
- Adoption: `examples/wallet-example-app/test/fixtures/events/baseline.json` (8 types) and `examples/course-enrolment-app/test/fixtures/events/baseline.json` (2), each with a test that asserts them with `requireCoverage`. They were generated once from today's definitions (the deposit, withdrawal and transfer fixtures carry the period tags the commands add as scope tags). Honest limit: a baseline captured now protects against future incompatible changes only; it cannot say whether anything written in the past still decodes (that is what `verify-events`, next, checks against real data).
- Tests: 11 unit for the helper (compatible change passes; tag derived from a defaulted field, rename, new required field, dropped tag, scope tag allowed, removed definition, uncovered type, several shapes of one type, assert and requireCoverage, capture, load) and 2 adoption tests. Mutation-checked: renaming `newBalance` in the wallet's DepositMade fails with "Missing key at balanceAfter". Unit 564, typecheck clean.
- Next: `verify-events` (decode stored events by type against the current definitions, sampling by type and position range), then the DCB rule A check and a docs note.

## ADR-0017 step 4: verify-events (uncommitted)
- `verifyEvents({ definitions, sample?, all?, batchSize?, fromPosition?, toPosition?, types?, maxPositions? })` in `@crablet/commands/VerifyEvents` (+ `formatEventsReport`): read-only; per type it decodes stored events with the current definition and reports checked/total, failures, the first failing positions, the issues (path + message + count), the decodable events lacking a tag the definition derives now (`inventedTags`, DCB rule B on real data) and the types in the range that no definition accounts for. Default: a random sample of 1,000 per type (`ORDER BY random() LIMIT`); `all` walks in position order with a keyset in batches. `ok` is false on any unreadable event or tag drift; unknown types are listed, not failed.
- `examples/wallet-example-app/scripts/verify-events.ts`: the operator script (env as the app, flags `--all --sample --from --to --type`), exit code 1 on failure. Run end to end against a real Postgres: exit 0 on a readable log; with an old-shape DepositMade, exit 1 and "Missing key at newBalance (1) / depositedAt / description".
- Bug found by the test: `ORDER BY position` after `position::text AS position` sorts by the OUTPUT column (text), so '10' < '7'; fixed with `ORDER BY crablet_events.position` (the same trap EventStore documents for transaction_id). It would also have corrupted the keyset batches.
- Tests: 3 real-Postgres (counts/positions/issues/tag drift/unknown types; sample, `all` in batches of 5, range and type filter; empty and readable logs). Unit 564, integration 332, typecheck clean.
- Next: the DCB rule A check (event types present in the log under a model's binding tags that the model neither handles nor declares as deliberately ignored), then a note in the tutorial and README.

## Spike: DCB rule A at the type level (uncommitted, awaiting your decision on the API)
- Question: can the compiler do what a Java sealed interface + exhaustive switch does, i.e. refuse a model that forgets an event type that carries its binding tags? Answer: yes, with limits. `EventDef` already carries `Type` and `TagKeys` as types (even for computed `const` keys); the builder now also tracks `Handled`, `Ignored` and `Binds` in its type (defaults keep every existing reference valid), and `.completeFor(registry)` makes the registry parameter an error object naming `missing` when the model does not account for a type carrying one of its keys.
- API added to `ModelBuilder` (type-level plus metadata, no change to the boundary, fold or snapshots): `.ignores(...events)`, `.completeFor(registry)`; `ModelInstance` gains `handles`, `ignores`, `bindings`. `CompleteFor` is exported for tests.
- Evidence: prototype first, then the real builder. The real wallet: `WalletModel` was missing WalletStatementClosed and WelcomeNotificationSent, `WalletLifecycleModel` five types, `StatementTracking` five; removing the real WithdrawalMade handler fails with `missing: "WithdrawalMade"`. Cost: 12 `.ignores` entries for the wallet's 3 models and 8 events. Perf: a 100-handler chain over a 100-event registry adds ~36k instantiations (424k baseline), check time unchanged (0.27 s). The 41 existing models compile unchanged; one test that reassigned a builder in a conditional had to become an expression.
- Tests: `test/model-completeness.types.ts` (compile-time: complete passes, missing is an error and names the type, ignoring and handling both count, a second binding key widens the check, a non-literal key accepts anything, a vacuity guard), 3 runtime tests in model.test.ts (ignores changes neither boundary nor fold, the metadata, ordering with snapshot). Unit 567, integration 332, typecheck clean.
- Limits recorded in ADR-0017 (the seal is the registry, history is invisible to the compiler, non-literal keys, over-counting the default key, narrower builder type, tsc truncation, no wildcard).
- The wallet changes (WalletModel.ts, WalletStatementPeriodResolver.ts) are part of the spike; keep or drop them with the API.

## The change-impact report (DCB rule A, slice-friendly form) (uncommitted)
- Why: after the type-level spike, the comparison with vertical slice architecture (Bogard: "minimize coupling between slices, maximize coupling in a slice") showed `.completeFor(registry)` couples slices through a shared registry and scales its `.ignores` boilerplate with slices x events. The report keeps the safety without touching the slices.
- `@crablet/commands/ModelImpact`: `modelFactsOf(name, instance)` (handles, ignores, bindings; already exposed by instances), `eventFactsFromFixtures(definitions, fixtures)` (tag keys derived from payloads, not scope tags) and `eventFactsFromLog` (via `crablet_event_tags`), `modelImpact({ events, models, baseline })` -> findings / newFindings / staleBaseline / ok, `formatImpactReport`, `baselineOf`, `loadBaseline` / `saveBaseline`, and `assertModelImpact({ events, models, baselineFile })` for a test (`UPDATE_MODEL_IMPACT_BASELINE=1` rewrites the baseline; review the diff). The check fails on a NEW finding and on a STALE baseline entry (so a resolved pair cannot regress silently).
- Adoption: wallet (`examples/wallet-example-app/test/model-impact.test.ts` + `fixtures/model-impact-baseline.json` with the 12 reviewed pairs; `StatementTracking` exported for it) and course (no baseline needed). The wallet's spike edits (`.completeFor` and 12 `.ignores` in WalletModel.ts and the period resolver) were reverted: the models are as committed.
- Verified on the real wallet by adding an event type: `DepositReversed` tagged `wallet_id` -> 3 NEW findings (WalletModel, WalletLifecycleModel, StatementTracking); `.ignores(DepositReversed)` on the lifecycle model cleared that one only. Everything restored afterwards.
- Tests: 11 unit (finding, accounted by handle or ignore, unrelated tags never reported, second binding key, baseline accepts reviewed pairs and fails on new ones, stale entries fail, models without metadata, facts from real models and fixtures, baseline file round trip, assert + UPDATE) and 2 real-Postgres (facts from the log, empty log). Unit 580, typecheck clean.
- Still in the working tree and to be decided: the compile-time `.completeFor` and the three extra type parameters of `ModelBuilder` (+ `test/model-completeness.types.ts`, the `verify-snapshots` test change). Recommendation: remove `.completeFor` and keep `.ignores` + the instance metadata.

## Reasons in the impact baseline (uncommitted)
- A baseline entry is now `{ model, eventType, reason }`; `isExplained` needs at least `MIN_REASON_LENGTH` (12) characters after trimming, so "", "n/a", "todo" and "ok fine" fail. The report has `unexplained` (entries of current findings without a real reason), shown as `UNEXPLAINED baseline entry ...`; `ok` needs no new findings, no stale entries and no unexplained ones.
- A refresh (`UPDATE_MODEL_IMPACT_BASELINE=1`) keeps existing reasons (`baselineOf(report, previous)`), gives new pairs a blank reason, writes the file, and then runs the check, which fails until each new pair has a reason: refreshing is not an approval. A baseline file written before reasons loads with blank reasons. A refresh of a complete baseline leaves the file byte-identical (checked), so diffs show only real changes.
- The wallet's 12 entries now have reasons (my reading of the domain from the code; someone who owns the wallet domain should read them). Verified the whole flow on the real wallet by adding `DepositReversed`: 3 NEW findings -> refresh -> 3 UNEXPLAINED, still failing -> reasons written -> passes; everything restored. The demo also showed the limit: a reason written as "CHANGE NEEDED? ... this must become .on(DepositReversed)" passed the length check, because the check enforces that a reason EXISTS, not that it is right.
- Tests: 15 unit for ModelImpact (4 new: unexplained reasons, refresh keeps reasons, legacy files, refresh not an approval). Unit 584, typecheck clean.

## completeFor removed (uncommitted; decision 2026-10-07)
- Removed the compile-time completeness: `.completeFor(registry)`, the `CompleteFor` / `Relevant` / `MissingEvents` types, the three extra type parameters of `ModelBuilder` (`Handled`, `Ignored`, `Binds`) and the `const By` of `defineModel`, `test/model-completeness.types.ts`, and the `verify-snapshots` test workaround (the original conditional re-assignment compiles again). The builder is `ModelBuilder<S, Scope>` as before.
- Kept: `.ignores(...events)` (no runtime effect on boundary or fold) and the instance metadata `handles`, `ignores`, `bindings`, which the change-impact report reads. Net change of `Model.ts` against the last commit: +17 / -3 lines.
- Why: it coupled slices through a registry (against vertical slice architecture and bounded-context autonomy), grew the public type of the builder and narrowed it, and the report gives the same safety with a committed, reviewed baseline. The findings of the spike (perf, noise, limits, the wallet result) stay in ADR-0017 under "Spike result (2026-10-07)"; the code is not kept anywhere (it was never committed).
- Tests: model.test (the ignores and metadata tests no longer call completeFor), unit 584, typecheck clean.

## The plan document brought up to date again (2026-10-07)
- `docs/plans/reliability-and-scale-diagnostic.md`: a status line that matches the code (steps 1-4 done, step 5 built with only the docs note left, step 6 not started); a status line under each of F1-F6; step 5 added to "Results of the fixes" (commits, an E7 row, a "shipped" entry); the step 5 row says Accepted and Built; "What I did not measure" gained the step 5 items (including that the impact report has found no real bug yet); Decisions split into resolved (ADR-0017 accepted, the rule A mechanism, with the removed compile-time variant recorded) and open (the 5 s retry, and whether to extend the report to subscriptions); and a "Remaining work" list.

## The docs note: two guides (uncommitted)
- `docs/evolving-events.md` (ADR-0017) and `docs/snapshots.md` (ADR-0018), linked from the README ("Learn more") and the tutorial ("where next").
- The code in them is real and tested: `packages/commands/test/support/evolving-events.ts` and `snapshots-guide.ts` (regions marked `// #region name`), run by `evolving-events-guide.test.ts` and `snapshots-guide.test.ts`. The markdown blocks are generated from the regions and `guides-sync.test.ts` keeps them equal (checked: changing `Effect.succeed(0)` in the guide fails it), and also checks that every relative link and every repository path written in backticks exists.
- Contents: the compatibility rule and what is and is not compatible; a field with a default, an optional field (personal data), a new event for an incompatible change; reading with `decodeStored` and what happens when an event cannot be read (commands, HTTP, views, automations); tags are additive-only; the three checks (fixtures, `verify-events`, the change-impact report with its reasoned baseline) and a checklist for changing an event; limits. For snapshots: the measured effect with its caveats, opting in and the migrations, what happens, what you must do (bump `version`), testing (`checkSnapshotEquivalence`), operating (`verifySnapshots`, pruning, metrics), limits (the tail read, `every`, no example app yet).
- Unit 613, typecheck clean.

## Decision: the 5 s leader retry is approved (2026-10-07)
- You approved, as is, the leader retry default of 5 s and the wake of followers on a graceful release (plan step 3, committed earlier on my recommendation). Recorded in the plan (Decisions item 7, the F2 status and the step 3 row). No decision now blocks the work; the optional items left are extending the change-impact report to subscriptions and a pilot on a larger domain, and, later, the retention decision of step 6.

## Plan step 6: storage visibility built; the tag table measured (uncommitted; decision pending)
- Built: `@crablet/eventstore/Storage` (`storageReport({ exact? })`, `recordStorage`, `monitorStorage({ every })`, `formatStorageReport`: every `crablet_*` table with estimated rows and bytes split into total/heap/indexes/toast from the catalog, no scan), gauges `crablet.storage.table_bytes|table_rows|bytes_per_event` (`StorageMetrics`), `examples/wallet-example-app/scripts/report-storage.ts` (run end to end against a real database), 3 real-Postgres tests. Typecheck and the suites below.
- Measured (E9, `packages/eventstore/diagnostics/storage.diagnostic.ts`, 1,000,000 wallet-shaped events through the real append path): 1,649 B per event (events table 644, tag table 1,004 = 61 %); the tag rows cost 74 % of append throughput (4,832 vs 18,718 events/s with the tag-row insert removed in a scratch database); in five poller selections (batch of 100) the tag table was never meaningfully faster than scanning `unnest(tags)`, and on a catch-up over a rare key it was the slowest (3,064 ms vs 2,075). A `tag_keys` GIN column is mixed (688 ms on that catch-up, but 7.9 vs 3.0 ms on a selective tail). The schema's own comment says the table exists to avoid exactly that scan.
- Mistakes of mine caught on the way: the first index listing skipped indexes not named `crablet_*` and undercounted the total (1,033 vs 1,649 B/event); the first `tag_keys` size comparison compared an events copy with fewer indexes than the original; my test keys covered only 100 % and 5 % of events, so a rare-key case was added after seeing the first full run.
- ADR-0019 (Proposed) records all of it, recommends dropping the tag table (NOT applied: it is a schema change and needs your decision), and leaves retention undecided on purpose (a modelling question first).

## Correction to the E9 conclusion about the pollers (uncommitted)
- Asked "should we check the impact on pollers?", I looked: E9b's read timings used hand-written SQL imitating the poller's fetch with a ONE-key filter, while the real consumers (four wallet views and the outbox topic) filter with `anyOfTags` = three keys, and `buildPendingSelectionQuery` (the caught-up check behind consistent reads, ADR-0015) was never measured. No concurrency, no equivalence test. ADR-0019 and the plan now say the tag table recommendation is NOT yet verified for the pollers and list the check (real builders, three-key selection, the pending check, an equivalence property test, the poller suites, concurrent load). The space and write-cost figures (61 %, 74 %) do not depend on this.

## The poller check, and what it changed (uncommitted)
- Committed first: the visibility work and ADR-0019 (`d467d9f`). Then ran the check on the pollers.
- Built: `buildEventSelectionQuery` / `buildPendingSelectionQuery` / `makeSqlEventFetcher` / `hasPendingSelectedEvents` take `{ tagKeys: "table" | "scan" }` (default `"table"`: behaviour unchanged), so the tag table and the events' own tags can be compared through the same code. An equivalence test (`tag-key-strategy-equivalence.test.ts`, real Postgres): 400 random selections and cursors over 2,450 events written through the real append path, 50 in constructed transaction-id/position inversions: identical fetches and pending answers (mutation-checked). It was flaky at first because its precondition (out-of-order positions) depended on timing; made deterministic. The consumer suites (180 tests) passed with the scan form as the default (default restored afterwards).
- Measured with the REAL builders (`packages/event-poller/diagnostics/tag-selection.diagnostic.ts`, E9d-E9f, 1,000,000 events, two full runs that agreed): the tag table is NOT useless: catch-up on a rare key 0.7 ms vs 2,539 ms scanning, pending check on a rare key 5.8 vs 162 ms; for the wallet's common keys it buys nothing. A slim `(key, position)` table has the same reads, 44 % of the space, 2.3 times the append throughput; under five pollers plus a writer: writer 2,463 -> 5,368 events/s, poller p95 36.7 -> 9.7 ms.
- Conclusion changed twice and is recorded as such: first "drop it" (from approximations, wrong), then, after the real-query check, "slim it, do not drop it". ADR-0019 is retitled ("heavier than its reads need") and says so. Lesson: a number measured with an approximation of the real query is not a measurement of the real query; it was caught only because you asked whether the pollers had been checked.
- Nothing applied: no migration written. The decision is yours.

## Migration V11: the slim tag-key table (built, approved 2026-10-07; uncommitted)
- `V11__crablet_slim_event_tag_keys.sql`: new `crablet_event_tag_keys (key, position)`, primary key only (no value, no other index, no foreign key); DISTINCT inserts (an event may carry a key twice: list-valued tags); backfilled from `crablet_events.tags` (source of truth; also repaired a raw-insert drift the old table had); `append_events_batch` rewritten; `crablet_event_tags` dropped; `LOCK TABLE crablet_events IN SHARE ROW EXCLUSIVE MODE` first (writers wait for the backfill, a full scan; readers continue). Pollers' two clauses, `eventFactsFromLog` and `Storage.ts` point at the new table. `startTestDb({ migrations })` and the re-exports `migrationFiles`/`sqlDir` in test-support let a test start at V10, fill it through the old function, then apply V11.
- Tests: `migration-v11.test.ts` (populated V10 database upgraded: same pairs, once each, plus the raw event's repair, tags without '=' ignored, old table gone, appends with list-valued tags afterwards, single-index shape, no foreign key, the writer pause really holds a second writer back; mutation-checked: without DISTINCT the list-valued append fails), the equivalence test (key table vs scanning), the whole integration suite (342) and unit (613). The differential test failed until its reset truncated both tables (no foreign key means CASCADE no longer clears the key table).
- Measured on the SHIPPED schema (1,000,000 events): 1,203 B per event, not the 1,086 I forecast (the slim table measured earlier was a compact copy built in one pass; incremental inserts give a less dense B-tree: 532 MiB, not 420); the 1M load 177 s -> 66 s; poller p95 under load 36.7 -> 7.0 ms; reads unchanged. The forecast error is recorded in ADR-0019.
- Slip of mine: a stray `cat > file` with no input hung a command for 500 s (the test file had never been written); noticed when the output file stayed empty.
- F4 downgraded to conditional after your objection that 190 ms at 100,000 events and 1.1 s at 500,000 are acceptable: they are, for many systems; the plan now says so, adds the rule of thumb (history = latency budget / 2 microseconds) and that modelling by period is the cheaper fix; the snapshots guide says "probably not, until you measure a problem".

## Snapshots dropped (2026-10-07; uncommitted)
- Decision: after an evaluation of the trade-offs (about 1,800 lines with tests and docs, two migrations and a function in every database, a `version` rule with a silent-wrong-state failure mode, personal data duplicated, no users, a cheaper remedy in modelling by period, F4 downgraded to conditional) you chose to drop the snapshot feature.
- Removed: `SnapshotStore` (+ collector, flush), `InMemorySnapshotStore`, `verifySnapshots`, `checkSnapshotEquivalence`, `SnapshotMetrics`, `loadWithSnapshot` / `.snapshot(...)` / `SnapshotOptions` in `Model.ts`, `settledState` on `ProjectionResult`, the executor's collector hook (`execute` is the former `executeOnce` again), `SnapshotStoreLive` in `Crablet.layer`, their package exports, 10 test files, the guide `docs/snapshots.md` (and its README/tutorial links and its sync-test entry), the snapshot write spike and E5e.
- Kept: `.ignores(...)` + `handles`/`ignores`/`bindings` on model instances (the change-impact report), the `all(...)` read horizon, `startTestDb({ migrations })`, the storage report, the evolving-events guide.
- Migrations: V9 and V10 stay in history; **V12 drops `crablet_model_snapshots` and `crablet_save_snapshot(...)`** (idempotent), tested on a database that had them with a row. Squashable if it is known that no database outside tests applied V9/V10.
- ADR-0018 is marked superseded with the removal record (reasons, recovery: the last commit containing the feature is `897f18c`, and the list of commits that built it); the measurements stay as history. The plan: F4 status, step 4 row, results, decisions, remaining work.
- Verified: typecheck clean, unit 578 (was 613), integration 322 (was 342; the snapshot tests are gone, V12's test added).

## Repeated batches: views exactly once, automations required to be idempotent (2026-10-09)
- Found: a view that ADDS (the wallet's balance and summary) doubled when the same batch was handled twice (balance 107 became 114; deposit and withdrawal totals 10 and 3 became 20 and 6); the transaction view did not (`ON CONFLICT DO NOTHING`). Two ways in: a crash between the view's commit and the cursor's update, and a zombie leader with its successor on the same batch (the fence checks then acts; ADR-0012's forward-only cursor stops a backwards cursor, not the zombie's batch).
- Built (`1460ebf`, ADR-0023): for views, `handle` and the cursor move are one transaction (`EventProcessorDeps.atomically`, `ProgressTracker.advanceCursor`); the cursor move is a compare-and-set and a batch that moves nothing is rolled back. Test written first: `view-exactly-once.test.ts` (24 instead of 12 in the race and in the retry after a crash, before). Cost, one local Postgres: +0.26 ms per one-event tick, no change draining a backlog. Not measured on AWS.
- Automations: the same did NOT work as first planned. A batch of commands in one transaction fails on `idx_crablet_commands_transaction_id` (the audit assumes one command per transaction). I had said "same database, so a rollback fixes it" without checking that; wrong.
- Spike, not merged (branch `spike/automation-effects`, `b04aac7`): the framework remembers per trigger event what each automation did (table keyed by automation, trigger position, command, hash of the input). Works (race, crash, fan-out, two automations on one trigger, a failing command, conflicts retried inside the transaction). Two lessons: write the record AFTER the command (written first it gives the transaction its xid early and a strict command conflicts on every retry; the automation went FAILED after 5 conflicts), and a nested `withWakeups` must join the outer one (a test fails without it). Cost: +0.82 ms per decision (+26%), draining 1,000 decisions 800 -> 500 per second. Not adopted: with `idempotentBy` kept it adds only protection against a key too narrow, and it cannot undo a key too broad.
- Decided with the user: automations must be idempotent, the outbox may repeat. `Command.idempotent` says whether `idempotentBy` was declared and `automationHandlerOf` throws for a command without it (`4a48dee`; a breaking change at start-up for an automation that had none; the wallet's already declared it). `idempotentBy` itself was already part of the API (since `d12a1b1`, 2026-09-30).
- Built (`130fe76`, `4e9e19b`): `assertAutomationIdempotent` / `checkAutomationIdempotency` (`@crablet/automations/testing/AutomationIdempotency`), a test the author calls, in memory: handles the triggers twice and reports NOT IDEMPOTENT (the repeat appended), TOO BROAD (a decision "already done" on the first pass) or FAILED (needs `given`). Only as good as the triggers given. `automation-idempotency-postgres.test.ts` runs 7 scenarios on the in-memory store and on real Postgres through the real CommandExecutor: same verdicts.
- Slips: my first Postgres backend read "the latest n positions" and got earlier scenarios' events (cause not found; reads by the append's transaction id now). I first explained it with sequence caching, which `BIGSERIAL`'s default of 1 contradicts, and took the claim out. My first debug print ran a scenario a second time on the same data, and I read that polluted output before noticing.
- Not done: nothing pushed; the questions about RDS Proxy, PgBouncer, Aurora Limitless (LISTEN/NOTIFY unsupported; advisory locks supported since 16.10.100, semantics not documented), a Redis or lease-table leader, and read replicas were analysed from documentation and code, not tested. The leader's session lock and `LISTEN` are the fragile parts behind a pooler; the append's transaction-scoped locks are not.

## Option B: the leader lock and LISTEN on a connection of their own (2026-10-09)
- Why: a pooler in transaction mode lends a server connection for one transaction. Spike against PgBouncer 1.26 in Docker (pool of 4): commands (40 concurrent, then 1,204 in 6 s) and a view's atomic batch work; the leader does not (a second instance took the lock 24 of 40 tries, the first saw it lost 38 of 40) and LISTEN hears 0 of 20, both silently. Controls: direct and session mode behaved. RDS Proxy pins instead of breaking (AWS docs: LISTEN and session-level advisory locks pin, transaction-level ones do not); not tested.
- Built (ADR-0024): `SessionClients` (`@crablet/eventstore/SessionClients`, an optional `Context.Reference`, default null, so no module gets a new required service), `sessionSql` / `sessionPg`, `sessionClientsLayer(config)`, `Crablet.layer(pg, { session })`; the three modules and `ViewProgressHubLive` take their leader and LISTEN from it; the wallet reads `WALLET_DB_SESSION_HOST` (+ `_PORT`, `_NAME`, `_USER`, `_PASSWORD`, `_POOL`). Omitted, nothing changes.
- Test: `session-clients.test.ts` asks the database who holds each leader lock and each LISTEN (two clients with different `application_name`); with the session client all belong to it, without it all to the application's. Checked that it can fail: putting the hub, or the views' leader, back on the application's client breaks it. Diagnostic (needs Docker, not in CI): `pgbouncer-session.diagnostic.ts`, the wallet through PgBouncer: split 15/15 commands with a consistent read worked (p50 61 ms); everything pooled 15/15 failed (503 at the 5 s wait).
- Surprise: in the everything-pooled control the leader locks looked stable (one backend each over 8 s), so a stable holder is not evidence that the leader works; I had expected flapping. The views did not catch up; I did not look at why (the likely reason, the fence failing, is a guess).
- Slips: the first replica test had `su-exec` where the image has `gosu`, and I forgot the framework's migrations (the helper only applies the example's); a PgBouncer spike harness first imported `testcontainers`, which does not resolve from the example package.
- Read replicas measured, not built (local streaming replica in Docker, one run): replication adds 1 to 6 ms (p99 5.8) over the primary's own view row under about 800 writes/s, and 18% of first checks on the replica were not yet there (the fallback path); at that rate the primary's view processor is the delay (p95 1.4 s), not the replica. Reads vs writes was confounded by the machine (readers on the replica cut writes by about half too), so it says nothing firm about relief. Decision left: do not build the read URL before the real read load and the Aurora replica lag are known.

## The first look of a consistent read is one statement (2026-10-09)
- Why: a default read sent four statements in a row (end of the log, the view's progress row, "anything pending?", the application's query); the first three are the framework's and wait for one another. The database spends 0.05 to 0.13 ms per read, so the cost was round trips and pool occupancy. Prototype under `tc netem` first (about half the latency, about twice the throughput), then built (ADR-0015, "Update: the first look is one statement").
- Built: `buildReadCheckQuery` (`event-poller/src/internal/sql.ts`, reusing `pushSelectionClauses`), `readCheck` (`views/src/ReadCheck.ts`), `viewVerdict` (`views/src/ViewVerdict.ts`, the one rule `waitUntilProcessed` and `readCheck` both end in), `ReadDeps.check` in `makeConsistentRead` (default on; replacing `deps` without `check` keeps the old path), `waitForViews` takes the verdicts. The application's query is still separate: the first look names only `crablet_events` and `crablet_view_progress`, and the view's query names no framework table (checked by `read-statements.test.ts` with `pg_stat_statements`, which also counts 2 statements per read; it fails with 4 if `check` is switched off).
- Tests written first: `view-verdict.test.ts`, `consistent-read-check.test.ts` (fake `check`: one call, `wait` only for the views behind, a marker beyond the log is a 400 also for an endpoint that reads no views, the same view twice by position, view_failed at once, order of the 503), and `read-check.test.ts` (equivalence with the three old statements, the verdict through the real `waitUntilProcessed`, random logs/selections/progress/markers, `table` and `scan`, 3 seeds, about 700 views, all three verdicts reached). The equivalence test fails if "pending" is computed up to the head instead of the write (checked).
- Measured with the real code (`read-first-look.diagnostic.ts`, simulated delay, one run): default read p50 1.25 -> 0.73 ms with no added delay and 12.74 -> 6.59 ms with +2 ms; read with a marker 17% to 31% less; two views about 47% less; 16 concurrent default reads +69% to +100%. Not measured on AWS. `bench-reads.ts` (the plan said to reuse it) was not run: the statement count and the delay diagnostic cover what it would show.
- A trap the equivalence test could not see: my first statement used `EXISTS` for the pending check, and on 100,000 events Postgres planned a Seq Scan of `crablet_events` for it (8 ms, growing with the log) and ran it even for a view already at the end of the log, where the old code never asked. Found because I compared the timings with the plans before relying on the prototype's numbers (the prototype had run on a log of about 100 events). The lateral "next matching event" form, gated by "the cursor is behind the write", with `ORDER BY ... LIMIT 1`, keeps the index: 0.6 to 1.05 ms for the whole first look across eight selection shapes and three distances. My E9g benchmark first ran the pending query even for a view at the end of the log, which the old code does not; corrected to mirror it.
- Side finding, NOT acted on: the existing `buildPendingSelectionQuery` (used by the waiting loop) takes 4 to 8 ms for a typical view selection 5,000 to 50,000 events behind on a 100,000-event log, and 48 ms for a required key present on every event, for the same Seq Scan reason; the `ORDER BY ... LIMIT 1` form gives 0.7 to 1 ms. A separate change.
- Diagnostics fixed on the way: `tag-selection.diagnostic.ts` appended 200 events per call, over the limit of 50 (E9d and E9e would have failed); and its "rare key" (`audit_id`) never occurs in the log (only deposits carry it, and the events numbered 10,000 * k are transfers), so those rows measure an absent key.
- Slips: `Effect.zipRight` does not exist in this Effect (used `andThen`); a test of mine used a "behind" cursor with a higher transaction id than the marker, which the cursor order (transaction id first) counts as ahead; a diagnostic hung because a failure before `dispose` left the pool open and my filtered output only appears at the end.
- One integration test failed once in a full run (the wallet's admin API, the outbox failure details under a percent-encoded id) and passed in the next full run and alone three times; I did not keep its message, so its cause is unknown. Not an area this change touches.
- Metric: `crablet.read.consistency.wait.duration` now includes the first look, so its p95 on the dashboard drops when this is deployed (ADR-0015, monitor-it guide).

## The pending query that the wait runs, fixed (2026-10-09)
- It is the side finding of the entry above: `buildPendingSelectionQuery` had no `ORDER BY`, so on 100,000 events the planner took a Seq Scan for it (4 to 8 ms for a typical view selection 5,000 to 50,000 events behind, 3 to 7 ms for one event type or no restriction, 45 ms for a required key present on every event, there a Seq Scan of `crablet_event_tag_keys` and one probe of the log per row). It runs on every turn of a consistent read's wait while the view is behind. Pushed `09d5a05` and `6a04f96` first.
- Measured before changing it (ten selection shapes, four distances, both `tagKeys` strategies, standalone query as it is against the same query with `ORDER BY e.transaction_id, e.position LIMIT 1`): 0.4 to 0.6 ms in every slow case with `table`, and nothing measurably worse; with `scan` the same for selections with a type, and a key that never occurs is an inherent scan (4 to 76 ms) either way.
- Test first: `pending-query-plan.test.ts` (100,000 events, reads `EXPLAIN` and fails on a Seq Scan of `crablet_events` or `crablet_event_tag_keys`; it also checks the query finds a match and finds none at the end of the log). My first version of it checked only `crablet_events` and so passed the required-key case, which is slow because of a Seq Scan on the OTHER table; I read the plan to see why and widened it. Four of four failed before the change, five of five pass after. The change is one line in `internal/sql.ts` plus a comment.
- Not re-measured: the million-event E9d diagnostic (ADR-0019), whose p95 tail of 170 to 370 ms for "the pending check for a view that has matches" may be the same cause; I only say it may.
- Verified: `tsc`, 834 unit, 389 integration.

## The flaky admin-api test: found, and it was the test (2026-10-09)
- The test that failed once in a full run ("the outbox's failure details are found under its JSON-pair id...") wrote `error_count = 3` straight into `crablet_outbox_topic_progress` and read it back. The outbox processor zeroes `error_count` after every batch it publishes (correct), and the wallets opened by the earlier tests may still be on their way out. Provoked on purpose (a command, then the write, then the read): the outbox zeroed the count in **8 of 40** tries. So not a defect in the framework; the entry above, "cause unknown", is replaced by this.
- Fix, in the test only: pause the outbox first (a paused processor starts nothing new; nothing else of the test changes), then write until the count reads 3 twice 150 ms apart (a batch already under way can still zero it once when it ends). With pausing, the same provocation: 40 of 40 stable, no second write needed.
- Checked: the file alone 12 times, six copies at once twice, the whole integration suite: all green (389). I did not wait for the original flake to come back; this is a reproduced cause and a fix verified against the reproduction, not an observation that it stopped happening.

## Testing the wallet behind PgBouncer, end to end: a defect in my own advice (2026-10-09)
- Asked to test with PgBouncer (no RDS Proxy yet), I wrote `pgbouncer-e2e.test.ts`: two instances, the application's connection through PgBouncer in transaction mode (server pool of 8), the leader locks and LISTEN direct, mixed load through both (190 commands, concurrent duplicates), the session connection of every leader killed under load, then instance A stopped. It reuses the chaos page's consistency checks (`dataChecks`).
- It failed on its first runs: after the kill, ONE role (the outbox in one run, the automations in another) never got a leader again (60 s observed), with nothing in the log. Not the pooler: with the split but no PgBouncer the same happened to another role; with no split and no pooler all three came back in 4.6 s. Instrumenting the retry loop showed both instances stuck in "acquiring" for ever.
- Cause, mine: the session pool. With `@effect/sql-pg@4.0.0` each `pg.listen` reserves a POOLED connection for as long as it lasts; a process has 4 (three modules' wake-ups, the views' progress hub), and up to 3 leader locks: 7 held for good. I had documented the session pool as needing "at most three" and 5 as the wallet's default, and that LISTEN used "a connection of its own, outside the pool". That came from reading an OLD copy of `@effect/sql-pg` (`node_modules/.old_modules-*`) instead of the version in use; the repository's own guide ("Size the pool") already said 7. With a pool of 5 the other roles' `reserve` waits for ever. With 12 all three came back in both runs.
- Fixed: the wallet's session pool defaults to 10; `sessionClientsLayer` warns below 7; `tryAcquireGlobalLeader` takes `reserveTimeout` (10 s) and fails naming the pool instead of waiting for ever, and it gives the connection back when its first statement fails or it is interrupted (before, either left the pool one connection short for good: a latent leak that also existed without any of this). Tests first (`leader-pool-exhausted.test.ts`, both hung before the change), `session-clients.test.ts` now requires exactly 4 LISTEN backends on the session client. ADR-0024 has a "Correction" section; the guide, SessionClients.ts and Crablet.ts comments and the wallet README say 7 / 10.
- The end-to-end test then passed 3 runs in a row (about 11 s each). It fails with a pool of 5 (2 of 2 runs) and with no session split. Its first version only killed the leaders, and A re-acquired all three each time, so it did not exercise a takeover by the other instance; it now also stops A under load and requires B to hold all three.
- The low-level test (three leaders on one client, backends killed together, pool 5 and 10, 16 rounds) recovered 48 of 48, which is why it took the whole-app run to see this.
- Not done: no RDS Proxy (none yet); the production deployment's real PgBouncer settings (pool mode, `server_idle_timeout`, `max_prepared_statements`) are the defaults of the Docker image `edoburu/pgbouncer` at the time of the run (1.26), not theirs; a failover of the Aurora writer was never exercised.

## More contention in the PgBouncer end-to-end test: it measured nothing at first, and then found a wallet bug (2026-10-09)
- Asked to make the test contend for real (and to fix its header, which said "transfers that conflict" when none had), I measured first. The load of 190 commands produced **no** conflict: no 409, no conflict retry, no rolled-back transaction. 240 debits on 3 wallets, 16 or even 64 at once, the same. The database saw at most one active session, and PgBouncer one server connection with 19 clients waiting.
- Cause, in my test setup: `host.docker.internal` resolves to an IPv6 address as well as an IPv4 one on Docker Desktop. PgBouncer tries the IPv6 one first ("Network unreachable") and waits `server_login_retry` (15 s) before the next server login, so it opened a server connection every 15 s and ran everything, serialised, on the first (20 transactions of 300 ms took 6.1 s; with the IPv4 literal 0.95 s, on 8 connections). Found by running PgBouncer alone, without the application, and reading the DATABASE's log, not PgBouncer's (which printed nothing). So EVERY earlier PgBouncer result of this session ran with the pooler's concurrency off: the diagnostic, the first versions of the end-to-end test, the spike in ADR-0024. Redone: commands (0 of 40 failed), the views' atomic batch and LISTEN (0 of 20) the same; the leader row changed (11 acquisitions by the second candidate in 40 tries instead of 24; the first's check false 40 of 40 instead of 38). ADR-0024 has a "Correction" section; the guide, the code comment and the diagnostic say it.
- With the IPv4 literal the contention is real and stable over 4 runs: 79 to 83 answered 409 and 415 to 446 conflicts retried out of 240 debits, 456 to 489 transactions rolled back, 9 database sessions in a transaction at once, 8 waiting on a lock, PgBouncer on 8 server connections. The test now REQUIRES that (PgBouncer ran transactions side by side; at least 10 conflict retries), so it cannot silently go back to a serialised pooler (checked: with `host.docker.internal` it fails on that assertion).
- And that contention failed a consistency check ("every transaction of events has one command in the audit": 437 transactions of events, 435 audited commands, 2 transactions with no command) in some runs. The orphans were `WalletStatementOpened` events. Reproduced on plain Postgres with no pooler and no contention beyond the same deposit id sent 3 times at once on 60 fresh wallets: 60 deposits (right) but **179 statement openings and 119 events with no command in the audit**. Two causes. (1) The wallet's `resolveActivePeriod` appended the opening with **no append condition**, so racing commands each opened their own statement (three for three racers). (2) The framework: what `prepare` appends commits when the command ends as an idempotent repeat or a no-op, and an idempotent result is not audited; the comment on `prepare` said it was rolled back "if the command is retried or fails" and did not say this. Not a pooler problem; it was just never exercised by anything that raced.
- Fixed (1): the opening now carries a condition over the wallet's statement tracking (`StatementTracking`, from the position it was read at, or from this command's own closing of the previous statement when there is one), as the closing branch already did. Test first, both failing before (`statement-open-race.test.ts`: the same deposit three at once, and four different deposits at once on a fresh wallet; 3 openings per wallet before, 1 after). NOT fixed (2): I documented it in the comment on `prepare` (`Command.ts`) instead of changing the executor, because rolling back idempotent and no-op results would change what every command's `prepare` can rely on; that is a decision, and a possible one (roll the transaction back when the result is idempotent).
- The end-to-end test catches (1) only sometimes (1 of 2 runs with the fix removed), so `statement-open-race.test.ts` is the reliable guard. It does catch the other two mistakes every time: the session pool of 5, and the serialised pooler.
- Slips of mine on the way: a `//` comment at the end of a line of arguments swallowed the rest of the line (the PgBouncer got no database credentials: "server login has been failing"); `set -- $cfg` in zsh again, so the first contention runs had zero workers and "0 conflicts" meant nothing; I read the metrics registry and got a counter that did not match the log until I used the retries counter, which does.
- Verified: `tsc`, 834 unit, 394 integration (392 + the 2 new), the end-to-end test 4 runs of 4 (about 22 s each).

