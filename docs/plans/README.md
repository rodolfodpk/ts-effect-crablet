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

Several plans mention `?waitFor=<view>`, which [ADR-0015](../adr/0015-read-consistency-by-marker.md) replaced with markers; those plans keep it as it was.
