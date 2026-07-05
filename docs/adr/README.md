# Architecture Decision Records

Lasting architectural decisions made during the TS/Effect port, extracted from the phase-by-phase
narrative in [`NOTES.md`](../../NOTES.md). Each ADR is self-contained: context, decision,
consequences. Process gotchas, one-off bugs, and phase status stay in `NOTES.md` — only decisions
with lasting effect on the codebase's shape get an ADR here.

- [ADR-0001: Hybrid Bun + Node runtime](0001-hybrid-bun-node-runtime.md)
- [ADR-0002: Single EventStore implementation via Effect's ambient transaction context](0002-single-eventstore-implementation.md)
- [ADR-0003: Non-commutative append concurrency protection stays at the SQL layer](0003-non-commutative-append-concurrency-protection.md)
- [ADR-0004: Commit-time serialization failures are handled via Cause inspection, not typed errors](0004-commit-time-failures-via-cause-inspection.md)
- [ADR-0005: LISTEN/NOTIFY built on PgClient.listen + pg_notify() SQL function](0005-listen-notify-implementation.md)
- [ADR-0006: Leader election via SqlClient.reserve + manually managed Scope](0006-leader-election-via-sql-reserve.md)
- [ADR-0007: Event-poller fiber model — one daemon fiber per processorId, one shared leader-retry fiber](0007-event-poller-fiber-model.md)
- [ADR-0008: No command-type auto-discovery — handlers passed explicitly at every call site](0008-no-command-type-auto-discovery.md)
