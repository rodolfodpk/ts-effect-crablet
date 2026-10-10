# Architecture Decision Records

Lasting architectural decisions made while building this framework, extracted from the phase-by-phase
narrative in [`NOTES.md`](../../NOTES.md). Each ADR is self-contained: context, decision,
consequences. Process gotchas, one-off bugs, and phase status stay in `NOTES.md` — only decisions
with lasting effect on the codebase's shape get an ADR here.

Note: ADRs 0001-0008 were recorded while the framework was still modelled on an earlier implementation,
which they call "the predecessor"; [ADR-0010](0010-declarative-command-api.md)
records that this repo is now its own product and no code or API follows that predecessor.

Grouped by what you are likely to need. Within a group the order is the order they were written.

## Start here

The four that explain the shape of what you use.

- [ADR-0010: A declarative command API (events, models, commands) over the append primitive](0010-declarative-command-api.md) - the authoring API
- [ADR-0011: The HTTP API and its OpenAPI description are derived from the domain model](0011-http-api-from-the-domain-model.md) - one definition, many consumers
- [ADR-0015: Read consistency is a property of the read, requested with a write marker](0015-read-consistency-by-marker.md) - read your own writes
- [ADR-0017: Events evolve by compatibility: a tolerant reader, and a new event for anything that is not](0017-event-evolution-by-compatibility.md) - changing events safely

## Writing and consistency

- [ADR-0003: Non-commutative append concurrency protection stays at the SQL layer](0003-non-commutative-append-concurrency-protection.md)
- [ADR-0004: Commit-time serialization failures are handled via Cause inspection, not typed errors](0004-commit-time-failures-via-cause-inspection.md)
- [ADR-0002: Single EventStore implementation via Effect's ambient transaction context](0002-single-eventstore-implementation.md)
- [ADR-0008: No command-type auto-discovery - handlers passed explicitly at every call site](0008-no-command-type-auto-discovery.md)

## Reading, delivery and the pollers

- [ADR-0012: Cursors are (transaction_id, position) pairs, not bare positions](0012-transaction-position-cursors.md) - why no event is skipped
- [ADR-0005: LISTEN/NOTIFY built on PgClient.listen + pg_notify() SQL function](0005-listen-notify-implementation.md)
- [ADR-0006: Leader election via SqlClient.reserve + manually managed Scope](0006-leader-election-via-sql-reserve.md)
- [ADR-0007: Event-poller fiber model - one daemon fiber per processorId, one shared leader-retry fiber](0007-event-poller-fiber-model.md)
- [ADR-0014: Live updates are a ping, sent after the commit, delivered at most once](0014-live-updates-by-ping.md)
- [ADR-0016: One LISTEN per process for view progress; a hub fans the pings out in memory](0016-one-listen-per-process-for-view-progress.md)
- [ADR-0021: Wake-ups are sent after the commit and coalesced, not inside every append](0021-wakeups-after-commit-and-coalesced.md) - **accepted**: built (coalesced wake-ups after the commit, with an `off` mode); 1.95 times the appends per second measured
- [ADR-0023: A view's batch and its cursor commit in one transaction, so a repeated batch is applied once](0023-view-batch-and-cursor-in-one-transaction.md) - **accepted**: built for views; automations and the outbox excluded, with the reasons
- [ADR-0024: The leader lock and LISTEN can use a connection of their own, so the rest can go through a pooler](0024-session-connections-for-leader-and-listen.md) - **accepted**: built; tested on PgBouncer in Docker, not on RDS Proxy

## Storage and operation

- [ADR-0025: A model declares its period, and the framework turns it in the command's own append](0025-the-framework-turns-the-period.md)
- [ADR-0022: One image, several runtime roles: the same code runs as one process or as separate deployments](0022-runtime-roles.md) - **proposed**: partly built and run (`WALLET_ROLES` in the wallet, a suite with several instances, the kind lab); the migration job and the health endpoint of the workers are in the lab, not yet decided as a whole
- [ADR-0020: The processors admin API is a description plus handlers, closed until the application says who may call it](0020-processors-admin-api.md)
- [ADR-0019: Storage is visible, and the tag table is heavier than its reads need](0019-storage-visibility-and-the-tag-table.md)
- [ADR-0018: A model's state can be snapshotted at a settled cursor; a snapshot is a cache, never a fact](0018-model-snapshots.md) - **superseded: the feature was dropped; its decision 8 (the read horizon of `all`) stays**

## Platform and project

- [ADR-0001: Hybrid Bun + Node runtime](0001-hybrid-bun-node-runtime.md)
- [ADR-0009: Build on Effect 4, pinned exactly](0009-effect-4-release-candidate.md)
- [ADR-0013: How the public API evolves - additive versus breaking](0013-api-evolution-additive-vs-breaking.md)

