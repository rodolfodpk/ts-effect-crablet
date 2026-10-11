# Reference

*Reference · developers and operators · none · look up*

Tables to look things up in. To learn the ideas, read the [concept pages](../README.md#concepts-understand-the-ideas) instead.

| Page | What is in it |
|---|---|
| [Commands and models](./commands.md) | `defineCommand` options, what `decide` returns, error kinds and their HTTP statuses, `defineModel`, `defineEvent`. |
| [Views](./views.md) | `defineView` operations, `viewTable` column types, processor settings. |
| [HTTP](./http.md) | Endpoints, command answers by status, read-consistency parameters and settings. |
| [Configuration](./configuration.md) | `Crablet.layer` options, the wallet's environment variables and health endpoints. |
| [Metrics and spans](./metrics.md) | Every metric and span the packages record. |
| [Database tables](./tables.md) | The tables the framework owns. |
| [Glossary](./glossary.md) | Every word the documents use. |

## Packages

| Package | What it is |
|---|---|
| [`packages/db-migrations`](../../packages/db-migrations/README.md) | The SQL migrations V1-V13 (event log, command audit, poller progress, conditional append, tag-key table), as a plain file bundle |
| [`packages/test-support`](../../packages/test-support/README.md) | A throwaway Postgres (Testcontainers) for integration tests |
| [`packages/eventstore`](../../packages/eventstore/README.md) | The event store: conditional append, tag queries, LISTEN/NOTIFY, leader election, a storage report; plus the spec and an in-memory store for tests |
| [`packages/commands`](../../packages/commands/README.md) | The authoring API: `defineEvent`, `defineModel`, `defineCommand`, the `CommandExecutor`, `Crablet.layer`, and Given/When/Then test helpers |
| [`packages/event-poller`](../../packages/event-poller/README.md) | Generic polling engine (progress tracking, backoff, leader-gated fibers) — the shared base the views, outbox, and automations modules build on |
| [`packages/views`](../../packages/views/README.md) | Read-model projections: `ViewProjector`s driven by the poller, with subscription and management services |
| [`packages/outbox`](../../packages/outbox/README.md) | Transactional outbox: per-topic publishers fed from the event stream by the poller |
| [`packages/automations`](../../packages/automations/README.md) | Automations: react to an event by issuing a follow-up command |
| [`packages/commands-http`](../../packages/commands-http/README.md) | A REST API over your commands, with RFC 7807 problem-detail errors |
| [`packages/processors-http`](../../packages/processors-http/README.md) | An admin API over the processors: list them (status, failures, cursor, backlog), pause, resume or reset one; closed until the application provides an authorization ([ADR-0020](../adr/0020-processors-admin-api.md)) |
| [`packages/views-http`](../../packages/views-http/README.md) | Consistent reads over views: a read can wait for a write's marker (or the head of the log) before it answers, and is refused with a 503 or marked stale if a view is behind (used by the wallet's and the course app's reads) |
| [`packages/metrics-otel`](../../packages/metrics-otel/README.md) | Metrics (commands, event store, poller, leader, views, outbox, automations, storage) |
| [`examples/course-enrolment-app`](../../examples/course-enrolment-app/README.md) | The [tutorial](../tutorial/README.md)'s small service: two rules decided together, Postgres, HTTP + OpenAPI, one view, reads that wait for a write's marker |
| [`examples/course-enrolment-ui`](../../examples/course-enrolment-ui/README.md) | A Foldkit page for that API: a typed client, marker reads, live updates ([tutorial step 5](../tutorial/05-a-page-that-uses-it.md)) |
| [`tools/processors-admin-ui`](../../tools/processors-admin-ui/README.md) | A generic Foldkit page for the processors admin API: a table of processors with Pause, Resume and Reset (with a confirmation); works against any application that mounts the API |
| [`tools/chaos-ui`](../../tools/chaos-ui/README.md) | A Foldkit page and a local server for the kind lab: who leads each module, the load generator, the pods, faults chosen to run for N minutes, a consistency check of the data, and a reset ([the guide](../guides/operate/run-the-kind-lab.md)) |
| [`examples/quickstart`](../../examples/quickstart/README.md) | The [README example](../../README.md) as a script that runs with no database |
| [`examples/wallet-example-app`](../../examples/wallet-example-app/README.md) | End-to-end example: wallet commands, views, an automation, an outbox, and HTTP composed together |

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
