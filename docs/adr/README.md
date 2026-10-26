# Architecture Decision Records

Lasting architectural decisions made while building this framework, extracted from the phase-by-phase
narrative in [`NOTES.md`](../history/NOTES.md). Each ADR is self-contained: context, decision,
consequences. Process gotchas, one-off bugs, and phase status stay in `NOTES.md` — only decisions
with lasting effect on the codebase's shape get an ADR here.

Note: ADRs 0001-0008 were recorded while the framework was still modelled on an earlier implementation,
which they call "the predecessor"; [ADR-0010](0010-declarative-command-api.md)
records that this repo is now its own product and no code or API follows that predecessor.

Grouped by what you are likely to need. Within a group the order is the order they were written.

## Where to learn the ideas

These records are for the history of each decision: its context, the options weighed and the consequences. To learn the ideas themselves, start with the
[concept pages](../README.md#concepts-understand-the-ideas); each one links the records behind it. The four that shape the API you use most:

- [ADR-0010: A declarative command API (events, models, commands) over the append primitive](0010-declarative-command-api.md) - the authoring API (accepted)
- [ADR-0011: The HTTP API and its OpenAPI description are derived from the domain model](0011-http-api-from-the-domain-model.md) - one definition, many consumers (accepted)
- [ADR-0015: Read consistency is a property of the read, requested with a write marker](0015-read-consistency-by-marker.md) - read your own writes (accepted)
- [ADR-0017: Events evolve by compatibility: a tolerant reader, and a new event for anything that is not](0017-event-evolution-by-compatibility.md) - changing events safely (accepted)

## Writing and consistency

- [ADR-0003: Non-commutative append concurrency protection stays at the SQL layer](0003-non-commutative-append-concurrency-protection.md) - accepted
- [ADR-0004: Commit-time serialization failures are handled via Cause inspection, not typed errors](0004-commit-time-failures-via-cause-inspection.md) - accepted
- [ADR-0002: Single EventStore implementation via Effect's ambient transaction context](0002-single-eventstore-implementation.md) - accepted
- [ADR-0008: No command-type auto-discovery - handlers passed explicitly at every call site](0008-no-command-type-auto-discovery.md) - accepted
- [ADR-0027: An id that is already taken is decided in `decide`, not flagged with `onDuplicate`](0027-a-taken-id-is-decided-not-flagged.md) - accepted; a match from a different request is no longer "already done" (0034)
- [ADR-0029: A command's lookup cannot write, and what it reads is protected](0029-a-lookup-cannot-write-and-is-protected.md) - accepted
- [ADR-0030: One polling config, with defaults; no `enabled`](0030-one-polling-config.md) - accepted
- [ADR-0031: A package's API and its plumbing are separate, and the line is enforced](0031-api-and-plumbing-are-separate.md) - accepted
- [ADR-0034: A repeat must be the same request, and every command says how it recognises one](0034-a-repeat-must-be-the-same-request.md) - **accepted**: a reused key with another body is a 422; a repeat carries a marker
- [ADR-0035: The same trigger cannot append the same request twice](0035-the-same-trigger-cannot-append-the-same-request-twice.md) - **accepted**: the database's backstop behind an automation's `idempotentBy`
- [ADR-0037: The declaration API: one shape, checked by the type checker](0037-the-declaration-api.md) - **accepted**: `define*(name, …).on(Event, handler)` for models, views and automations; `byModel()`; a model's tags checked
- [ADR-0038: A caller's input is typed, and a processor starts in a scope](0038-typed-run-input-and-scoped-processors.md) - **accepted**: `run` and `when` take the schema's input type; `start*Processor` owns a processor by a Scope
- [ADR-0039: A topic takes its publishers, and the feed takes views](0039-a-topic-takes-its-publishers.md) - **accepted**: `defineTopic(name, { publishers: [publisher] })`; no second list matched by name
- [ADR-0040: A result carries one marker, and a domain file has one import](0040-one-marker-and-one-domain-import.md) - **accepted**: `ExecutionResult.marker`; `@crablet/commands/Domain`
- [ADR-0041: The framework adds the tags a command's own model reads its events by](0041-the-framework-adds-a-models-tags.md) - **accepted**: missing scope and period tags are added at append; another value is refused
- [ADR-0042: An API is served in one layer, and its groups are typed against it](0042-serve-an-api-in-one-layer.md) - **accepted**: `serveApi`; read groups without `as any`; `problemOf`
- [ADR-0043: A deadline is an event in the log, and a processor runs its command when it is due](0043-a-deadline-is-an-event-in-the-log.md) - **accepted**: `deadline(...)` in a decision, fired by a processor of the event-poller engine with its own lock; the course app's payment window; Effect's workflow and cluster weighed and not used for the state
- [ADR-0044: Time in the domain is an Effect DateTime: `now` and `Instant`](0044-time-in-the-domain-is-a-datetime.md) - **accepted**: events stored encoded by their schema; `now` is a `DateTime.Utc`

## Reading, delivery and the pollers

- [ADR-0012: Cursors are (transaction_id, position) pairs, not bare positions](0012-transaction-position-cursors.md) - why no event is skipped (accepted)
- [ADR-0005: LISTEN/NOTIFY built on PgClient.listen + pg_notify() SQL function](0005-listen-notify-implementation.md) - accepted
- [ADR-0006: Leader election via SqlClient.reserve + manually managed Scope](0006-leader-election-via-sql-reserve.md) - accepted
- [ADR-0007: Event-poller fiber model - one daemon fiber per processorId, one shared leader-retry fiber](0007-event-poller-fiber-model.md) - accepted
- [ADR-0014: Live updates are a ping, sent after the commit, delivered at most once](0014-live-updates-by-ping.md) - accepted
- [ADR-0016: One LISTEN per process for view progress; a hub fans the pings out in memory](0016-one-listen-per-process-for-view-progress.md) - accepted
- [ADR-0021: Wake-ups are sent after the commit and coalesced, not inside every append](0021-wakeups-after-commit-and-coalesced.md) - **accepted**, narrowed by ADR-0028: built (coalesced wake-ups after the commit, with an `off` mode); 1.95 times the appends per second measured
- [ADR-0028: The framework decides the wake-up and session settings it can work out itself](0028-settings-the-framework-decides.md) - accepted
- [ADR-0023: A view's batch and its cursor commit in one transaction, so a repeated batch is applied once](0023-view-batch-and-cursor-in-one-transaction.md) - **accepted**: built for views; automations and the outbox excluded, with the reasons
- [ADR-0032: A cursor moves only from where its batch started](0032-the-cursor-moves-only-from-where-its-batch-started.md) - **accepted**: amends 0023; overlapping batches are applied once
- [ADR-0033: Delivery order is causal order, and a command's append is its transaction's first write](0033-delivery-order-is-causal-order.md) - **accepted**: what "in order" means, enforced
- [ADR-0036: Outbox delivery: a stable event id, a publish timeout, and partial progress](0036-outbox-delivery-event-id-timeout-and-partial-progress.md) - **accepted**: `event_id` is the message id; no index
- [ADR-0024: The leader lock and LISTEN can use a connection of their own, so the rest can go through a pooler](0024-session-connections-for-leader-and-listen.md) - **accepted**: built; tested on PgBouncer in Docker, not on RDS Proxy
- [ADR-0045: The leader's lease is its session: Postgres ends a lock session the leader stopped talking on](0045-a-leader-session-ends-itself-when-the-leader-goes-silent.md) - **accepted** (not run on AWS): built and tested on Postgres; `idle_session_timeout` on the lock session and a primary check; a silent partition's takeover bounded near 20 s instead of the keepalives' 388 s on RDS; the kind lab, a replica and AWS still to run
- [ADR-0046: One lock session and one LISTEN connection per process](0046-one-lock-session-per-process.md) - **accepted**: the locks of every module a process leads on one session with one heartbeat, and every `LISTEN` on one connection beside the pool (a leader of three modules holds 2 connections for good, not 7; a follower 1, not 4); an attempt's statements bounded; tested on Postgres and in the kind lab

## Storage and operation

- [ADR-0025: A model declares its period, and the framework turns it in the command's own append](0025-the-framework-turns-the-period.md) - accepted
- [ADR-0026: A view is declared as the operations each event stands for; the migration stays the truth for the tables](0026-views-declared-as-operations.md) - **accepted**: built in `@crablet/views`; the wallet and course views use it
- [ADR-0022: One image, several runtime roles: the same code runs as one process or as separate deployments](0022-runtime-roles.md) - **accepted**: built in the wallet (`WALLET_ROLES`, a health endpoint for the workers, the migration as a pre-deploy job); a suite runs every role, the outbox included, as separate instances, and the kind lab ran the failure scenarios
- [ADR-0020: The processors admin API is a description plus handlers, closed until the application says who may call it](0020-processors-admin-api.md) - accepted
- [ADR-0019: Storage is visible, and the tag table is heavier than its reads need](0019-storage-visibility-and-the-tag-table.md) - accepted
- [ADR-0018: A model's state can be snapshotted at a settled cursor; a snapshot is a cache, never a fact](0018-model-snapshots.md) - **superseded: the feature was dropped; its decision 8 (the read horizon of `all`) stays**

## Platform and project

- [ADR-0001: Hybrid Bun + Node runtime](0001-hybrid-bun-node-runtime.md) - accepted
- [ADR-0009: Build on Effect 4, pinned exactly](0009-build-on-effect-4-pinned.md) - accepted
- [ADR-0013: How the public API evolves - additive versus breaking](0013-api-evolution-additive-vs-breaking.md) - accepted

