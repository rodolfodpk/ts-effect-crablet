# Plans

These are **records**, not a roadmap. Each plan was written before a piece of work and kept after it, with what was found while doing it. Read them to see why
something is the way it is and what was measured; you do not need them to use the project. The lasting conclusions are in the [decision records](../adr/README.md).

| Plan | What it was for | Status |
|---|---|---|
| [`poller-cursor-fix.md`](./poller-cursor-fix.md) | Pollers could permanently skip events; the cursor became `(transaction_id, position)` | Done ([ADR-0012](../adr/0012-transaction-position-cursors.md)). Its "What exists" section describes the code before the fix |
| [`foldkit-ui-example.md`](./foldkit-ui-example.md) | A Foldkit page for the course-enrolment API (tutorial step 5) | Done (phases 0-5) |
| [`typed-command-client.md`](./typed-command-client.md) | Put the commands in the API's type so the page needs no cast | Done (phases 0-3). Its "What exists" section describes the code before the change |
| [`api-follow-ups.md`](./api-follow-ups.md) | Seven API questions the page surfaced | A, C, D, E, F done; B (OpenAPI evolution rules) **deferred** until an external consumer exists; G (Foldkit server rendering) an optional spike, **not started** |
| [`read-consistency.md`](./read-consistency.md) | Reads that wait for a write's marker ([ADR-0015](../adr/0015-read-consistency-by-marker.md)) | Done, phases 0-7, except phase 1b (a marker on idempotent repeats), which was not built (a client that retries after a lost response reads with `consistentWith=latest`) |
| [`shared-listener.md`](./shared-listener.md) | One LISTEN per process for view progress ([ADR-0016](../adr/0016-one-listen-per-process-for-view-progress.md)) | Done (phases 1-4) |
| [`reliability-and-scale-diagnostic.md`](./reliability-and-scale-diagnostic.md) | What breaks at scale and under failure, measured, then fixed (six steps) | Done; snapshots were built and then dropped; retention not decided |
| [`newcomer-accessibility.md`](./newcomer-accessibility.md) | Make the repository easy to enter | Done (all nine steps, 2026-10-07) |
| [`test-coverage.md`](./test-coverage.md) | Improve test coverage, starting by measuring the integration tests too; packages only; a ratchet in CI | Done (all six steps, 2026-10-08): the real merged coverage was 98.5 %, now 99.7 % locally, gated in CI; three of seventeen deliberate breaks survived and were closed; a 90 % per-file floor and checked exclusions |
| [`mutation-testing.md`](./mutation-testing.md) | Mutation testing of the core packages: a pilot, two tiers, triage, a ratchet | **Proposed** (2026-10-08); a pilot ran in a throwaway copy, nothing in the repository |
| [`kind-lab.md`](./kind-lab.md) | The wallet as separate deployments on a local Kubernetes cluster (kind), broken on purpose: rolling update, a pod killed, a silent network partition, a node lost, the migration race, running out of connections, a long write transaction | Run once through (2026-10-08); a baseline on a laptop. Failover loses nothing; a silent partition takes 28 s to 388 s depending on the Postgres keepalives; Flyway closes the migration race; RDS-specific behaviour not verified |
| [`dashboard.md`](./dashboard.md) | A Grafana dashboard and alerts for the poller and its consumers, fed by OpenTelemetry; closes the lag-metric gap; an optional admin API and page to act on a processor | Done (2026-10-08): the consumer gauges, a generated dashboard with alerts and a sync test, a one-image local stack, an admin API with a generic Foldkit page, and the contributor rules; the plan lists what was not verified |
| [`period-rollover.md`](./period-rollover.md) | A period-scoped model closes the previous period and opens the new one by itself (`.period`), in the command's own append, instead of a `prepare` the developer writes | Done for months, days and years (2026-10-09; [ADR-0025](../adr/0025-the-framework-turns-the-period.md)); weeks, hours and zones not built |

Several plans mention `?waitFor=<view>`, which [ADR-0015](../adr/0015-read-consistency-by-marker.md) replaced with markers; those plans keep it as it was.
