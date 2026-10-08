# Reference

The details behind the [README](../README.md): what a command can declare, how views and reads behave, the HTTP layer, operating it, the packages, and how to build and test.

## What a command can say

Beyond `model` and `decide`, a command can declare (full list: [ADR-0010](./adr/0010-declarative-command-api.md)):

- `idempotentBy` - a repeat of the same operation is "already done", checked before anything else;
- `consistency: () => concurrent({ guard })` - safe to run in parallel with itself (e.g. deposits); only the `guard` events can conflict;
- `errors: [...]` - the domain errors it can fail with, checked against `decide`. Each carries a `kind` (`not_found`, `invalid`, `conflict`, `forbidden`)
  that the REST API maps to 404/400/409/403 and documents in the generated OpenAPI description, with no per-command HTTP code;
- `retries` (default 3) - a `Conflict` re-runs the command with fresh state.

A rule that spans several things combines models: `all({ from: AccountModel.of({ id: a }), to: AccountModel.of({ id: b }) })` decides on both and
conditions the append on the union of their boundaries ([DCB guide](./dcb-guide.md)).

Events can change shape without rewriting the log: a compatible change (a defaulted or optional field) keeps the name, anything else is a new event.
A stored event that cannot be read is a typed `EventDecodingError` (never skipped, never carrying the payload), and checks keep the models honest:
fixtures, `verifyEvents`, and a change-impact report with a committed baseline ([ADR-0017](./adr/0017-event-evolution-by-compatibility.md),
[guide](./evolving-events.md)).

## Views, the outbox and automations

They are fed by pollers. Guarantees: **no event is skipped** (cursor is a `(transaction_id, position)` pair,
[ADR-0012](./adr/0012-transaction-position-cursors.md)); **at-least-once**, so handlers must be idempotent; delivery is ordered by transaction,
then position, so do not use "position is bigger than the last one I saw" as a general idempotency check; and a long-running transaction anywhere in
the database delays delivery until it ends.

Views update asynchronously. A command answers with a **marker** (where in the log the write ended), and waiting belongs to the read: a read that carries it
(`?consistentWith=<marker>`) is answered only once the views it uses have that write, and a read with no marker waits for everything committed. The default is strict: the
answer is right or a `503`, never stale ([ADR-0015](./adr/0015-read-consistency-by-marker.md)). A client that did not write learns of changes by a ping over server-sent
events ([ADR-0014](./adr/0014-live-updates-by-ping.md)).
Walkthrough: [tutorial step 4](./tutorial/04-read-your-own-writes.md).

## HTTP API and OpenAPI

List the commands' **contracts** (`commandContract({ name, input, errors })`) and you get `POST /api/commands/<name>` for each, validated against the
`input` schema, with every failure documented as `application/problem+json`. `GET /openapi.json` serves the generated OpenAPI 3.1 description, checked in at
[`docs/api/wallet-openapi.json`](./api/wallet-openapi.json) so an API change is a visible diff. A browser can import the contracts without receiving
`decide` or the models. Walkthrough: [tutorial step 3](./tutorial/03-an-http-api.md); why: [ADR-0011](./adr/0011-http-api-from-the-domain-model.md).

## Operating it

- **Leadership.** Each poller runs on one process at a time, chosen by a session-level advisory lock. The heartbeat checks `pg_locks` for the session, a
  fence runs before the handler and before the cursor moves, and the cursor can only move forward, so a stale leader cannot deliver or rewind.
  A graceful release wakes the others at once; a crash is picked up on the next retry (5 s by default). Processors started with `startScoped` are released when their scope closes, so a shutdown signal
  under `NodeRuntime.runMain` is a graceful release ([Run it in production](./guides/run-in-production.md)).
- **Traces and logs.** Spans for commands, boundary reads, appends and handled batches, and log lines that say which processor or command wrote them; no exporter is shipped ([Monitor it](./guides/monitor-it.md#traces-and-log-context)).
- **Consumer lag.** `monitorProcessors()` (`@crablet/event-poller/MonitorProcessors`) keeps `crablet.poller.lag_events`, `lag_seconds`, `cursor_position` and `status` current in every instance, counted against each processor's own selection ([Monitor it](./guides/monitor-it.md#are-the-consumers-keeping-up)).
- **Storage.** `storageReport()` and `monitorStorage()` (`@crablet/eventstore/Storage`) report the size of the log and its indexes, and `metrics-otel`
  exposes them as `crablet.storage.*` gauges; `examples/wallet-example-app/scripts/report-storage.ts` prints the report. A tag-key table keeps the pollers'
  tag filters cheap (about 1.2 KB per event in all). Nothing deletes events, and retention is not decided ([ADR-0019](./adr/0019-storage-visibility-and-the-tag-table.md)).
- **Evidence.** What was measured, what broke and what was fixed: [`docs/plans/reliability-and-scale-diagnostic.md`](./plans/reliability-and-scale-diagnostic.md).

## Packages

| Package | What it is |
|---|---|
| [`packages/db-migrations`](../packages/db-migrations/README.md) | The SQL migrations V1-V12 (event log, command audit, poller progress, conditional append, tag-key table), as a plain file bundle |
| [`packages/test-support`](../packages/test-support/README.md) | A throwaway Postgres (Testcontainers) for integration tests |
| [`packages/eventstore`](../packages/eventstore/README.md) | The event store: conditional append, tag queries, LISTEN/NOTIFY, leader election, a storage report; plus the spec and an in-memory store for tests |
| [`packages/commands`](../packages/commands/README.md) | The authoring API: `defineEvent`, `defineModel`, `defineCommand`, the `CommandExecutor`, `Crablet.layer`, and Given/When/Then test helpers |
| [`packages/event-poller`](../packages/event-poller/README.md) | Generic polling engine (progress tracking, backoff, leader-gated fibers) — the shared base the views, outbox, and automations modules build on |
| [`packages/views`](../packages/views/README.md) | Read-model projections: `ViewProjector`s driven by the poller, with subscription and management services |
| [`packages/outbox`](../packages/outbox/README.md) | Transactional outbox: per-topic publishers fed from the event stream by the poller |
| [`packages/automations`](../packages/automations/README.md) | Automations: react to an event by issuing a follow-up command |
| [`packages/commands-http`](../packages/commands-http/README.md) | A REST API over your commands, with RFC 7807 problem-detail errors |
| [`packages/processors-http`](../packages/processors-http/README.md) | An admin API over the processors: list them (status, failures, cursor, backlog), pause, resume or reset one; closed until the application provides an authorization ([ADR-0020](./adr/0020-processors-admin-api.md)) |
| [`packages/views-http`](../packages/views-http/README.md) | Consistent reads over views: a read can wait for a write's marker (or the head of the log) before it answers, and is refused with a 503 or marked stale if a view is behind (used by the wallet's and the course app's reads) |
| [`packages/metrics-otel`](../packages/metrics-otel/README.md) | Metrics (commands, event store, poller, leader, views, outbox, automations, storage) |
| [`examples/course-enrolment-app`](../examples/course-enrolment-app/README.md) | The [tutorial](./tutorial/README.md)'s small service: two rules decided together, Postgres, HTTP + OpenAPI, one view, reads that wait for a write's marker |
| [`examples/course-enrolment-ui`](../examples/course-enrolment-ui/README.md) | A Foldkit page for that API: a typed client, marker reads, live updates ([tutorial step 5](./tutorial/05-a-page-that-uses-it.md)) |
| [`examples/processors-admin-ui`](../examples/processors-admin-ui/README.md) | A generic Foldkit page for the processors admin API: a table of processors with Pause, Resume and Reset (with a confirmation); works against any application that mounts the API |
| [`examples/quickstart`](../examples/quickstart/README.md) | The [README example](../README.md) as a script that runs with no database |
| [`examples/wallet-example-app`](../examples/wallet-example-app/README.md) | End-to-end example: wallet commands, views, an automation, an outbox, and HTTP composed together |

## Build & test

Requires Node 24+ (see `.nvmrc`) and Bun 1.4+.

```bash
bun install
bun run typecheck          # tsc --noEmit across the whole workspace
bun run test:unit          # fast tests, no database - runs under Bun
bun run test:unit:coverage # same suite, with an lcov report at coverage/lcov.info
bun run test:integration   # real Postgres via Testcontainers (needs Docker) - runs under Node
```

The in-memory store and Postgres pass the same conformance suite plus a differential test on random histories, so scenarios are a faithful stand-in;
concurrency (races, conflict retry) is tested against Postgres only.
