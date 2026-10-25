# Roadmap

*Status · adopters and contributors · none · 3 minutes*

Where the project is, what is open, and what is deliberately not decided. It is written from the [plans](docs/history/plans/README.md) and the
[decision records](docs/adr/README.md); when one of those changes, this page changes with it. Nothing here has a date.

## Where it is

**Pre-release.** The framework is complete enough to build and run an application: commands with dynamic consistency boundaries, views, automations,
an outbox, an HTTP layer with OpenAPI, consistent reads, leadership with failover, event evolution checks, metrics, a dashboard and a chaos lab
([what is guaranteed and measured](docs/evidence.md)). The API is not stable: a breaking change is made whenever it is worth it, and the packages are
not on npm ([ADR-0013](docs/adr/0013-api-evolution-additive-vs-breaking.md)).

## Open work

| Item | State | Record |
|---|---|---|
| Mutation testing of the core packages | proposed; a pilot ran outside the repository | [plan](docs/history/plans/mutation-testing.md) |
| `Period.hour` | needs a "latest matching event" primitive in the event store first, because the turnover read grows with the number of periods | [period follow-ups](docs/history/plans/period-follow-ups.md) (B1, B2) |
| A leader lease with a deadline in Postgres | a named follow-up, so a silent partition does not depend on TCP keepalives (388 s with the RDS defaults) | [kind lab](docs/history/plans/kind-lab.md) |

## Deliberately not decided

| Question | Why it is open | Record |
|---|---|---|
| Retention: deleting or archiving old events | No usage that needs it yet; storage is made visible instead | [ADR-0019](docs/adr/0019-storage-visibility-and-the-tag-table.md) |
| Erasing personal data (crypto-shredding) | Planned; fields are already marked with `personal(...)`, so encryption can follow the same declaration | [events over time](docs/concepts/events-over-time.md#personal-data) |
| Rules for evolving the OpenAPI description | Deferred until there is an external consumer | [API follow-ups](docs/history/plans/api-follow-ups.md) (item B) |
| Server rendering of the Foldkit pages | An optional spike, not started | [API follow-ups](docs/history/plans/api-follow-ups.md) (item G) |
| Tested against RDS Proxy and a managed database | Not done; the pooler path was tested on PgBouncer in Docker | [ADR-0024](docs/adr/0024-session-connections-for-leader-and-listen.md) |

## Before a 1.0

Nothing is scheduled. What a 1.0 would have to include, from the records above:

- the packages published to npm;
- the API stability machinery ADR-0013 deferred: per-version snapshots of the public API, a breaking-change test, and versioned paths;
- a supported way to apply the migrations with several instances (the files already follow Flyway's naming).
