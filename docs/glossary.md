# Glossary

Plain-words definitions, in the order you meet them. Each links to where the term is taught.

## The idea

- **Event** - a fact that happened, immutable, stored in one log shared by everything (`SeatBooked`, `DepositMade`). Defined with `defineEvent`: a name, a payload schema and the tags it can be found by. [Tutorial step 1](./tutorial/01-the-rule-in-memory.md)
- **Tag** - a `key=value` label on an event saying what it is about (`seat_id=12A`). Events are found by their tags; there are no streams. [DCB guide](./dcb-guide.md)
- **Query** - a set of "event types, with these tags" items that selects events from the log.
- **Dynamic Consistency Boundary (DCB)** - the set of events a command's decision depends on, chosen by the command itself by querying, instead of fixed in advance as an aggregate. Two commands conflict only if one adds an event the other's boundary would have included. [DCB guide](./dcb-guide.md)
- **Model** - what events mean for one entity or rule: a pure fold from events to state (`defineModel`). The same declaration gives the boundary, so the fold and the boundary cannot drift apart. [Tutorial step 1](./tutorial/01-the-rule-in-memory.md)
- **`all(...)`** - combines several models into one decision (both wallets of a transfer). Its boundary is the union of theirs. [DCB guide](./dcb-guide.md)
- **Command** - a named, pure decision: from the loaded state and the input, it emits events, refuses with a domain error, or does nothing (`defineCommand`). [Reference](./reference.md#what-a-command-can-say)
- **Domain error** - a refusal that belongs to the business (`SeatTaken`), declared on the command, with a `kind` the HTTP layer maps to a status code.
- **Append condition** - "append these events only if nothing matching this query is newer than this position". It makes the check and the write one atomic step. [ADR-0003](./adr/0003-non-commutative-append-concurrency-protection.md)
- **Conflict** - the append condition failed because the boundary changed. The command is re-run with fresh state (`retries`, default 3).
- **Idempotent** - repeating the operation has no further effect. A command can declare `idempotentBy`; delivery by the pollers is at-least-once, so an automation's command must declare it (`automationHandlerOf` refuses one that does not), an outbox publisher should deduplicate on `event.position`, and a view's projector is covered when it writes through the `sql` it is given (its batch and cursor commit together, ADR-0023).
- **Commutative command** - one that is safe to run in parallel with itself (deposits). It declares `concurrent({ guard })`; only the guard events can conflict.

## Positions and delivery

- **Position** - the number an event gets in the log when it is stored.
- **Cursor** - how far a consumer has read: a `(transaction_id, position)` pair, not a bare position, so a late-committing transaction is never skipped. [ADR-0012](./adr/0012-transaction-position-cursors.md)
- **Horizon** - a cursor placed before everything a read could have missed. `all(...)` uses the earliest horizon of its members as its cursor. [ADR-0018](./adr/0018-model-snapshots.md) (decision 8)
- **Poller** - the loop that reads new events after a cursor and hands them to a handler. Views, the outbox and automations are pollers. [Reference](./reference.md#views-the-outbox-and-automations)
- **Leader** - the one process that runs a **module**'s pollers (all the views, or all the automations, or all the outbox publishers), chosen by a PostgreSQL advisory lock held for the session: one lock per module, not per processor. [Architecture](./architecture.md#one-lock-per-module-one-leader-per-lock), [ADR-0006](./adr/0006-leader-election-via-sql-reserve.md)
- **Fence** - the check, before a handler runs and before the cursor moves, that this process still holds its module's lock, so a stale leader cannot deliver or rewind.
- **At-least-once** - an event may be delivered again after a crash, but is never skipped.
- **LISTEN/NOTIFY** - PostgreSQL's wake-up channel; it tells pollers that something new exists. It only wakes them; the cursor is what guarantees nothing is missed. [ADR-0005](./adr/0005-listen-notify-implementation.md)
- **Wake-up window** - how the event store sends the wake-up: not inside every append, but once per window (50 ms by default) after the commit, carrying the union of what was appended; the first one after an idle spell goes at once. `wakeupMode: "off"` sends none. [ADR-0021](./adr/0021-wakeups-after-commit-and-coalesced.md)
- **Role** - what one process of an application does, chosen at start-up: the wallet's `api`, `views`, `automations`, `outbox` (or `all`, one process). Roles talk only through Postgres, so the same image runs as one process or as separate deployments. [ADR-0022](./adr/0022-runtime-roles.md)
- **Kind lab** - the wallet run as separate deployments on a local Kubernetes cluster and broken on purpose, with a dashboard and a chaos page. [Run the kind lab](./guides/run-the-kind-lab.md)

## Reading and reacting

- **View** - a read model kept in a table by a projector. It updates asynchronously. [Tutorial step 4](./tutorial/04-read-your-own-writes.md)
- **Projector** - the handler that turns events into view rows (`ViewProjector`).
- **Marker** - a token a command returns saying where in the log its write ended. A read that carries it (`?consistentWith=<marker>`) waits until the views have that write. [ADR-0015](./adr/0015-read-consistency-by-marker.md)
- **Strict read** - the default: the answer is right or a `503`, never stale.
- **Outbox** - events published to something outside the database, per topic, from the same log and with the same delivery guarantees. [Reference](./reference.md#packages)
- **Automation** - a reaction: when an event appears, issue a follow-up command.
- **Ping** - the small server-sent event that tells a client "something changed, read again". [ADR-0014](./adr/0014-live-updates-by-ping.md)

## The project

- **ADR** - architecture decision record: one file per lasting design decision, with its context, the decision and its consequences. [Index](./adr/README.md)

## Evolving and operating

- **Compatible change** - a change old events still decode under: a field with a decoding default, or an optional field. Anything else becomes a new event name. [Evolving events](./evolving-events.md)
- **`EventDecodingError`** - a stored event the current definition cannot read. It is never skipped and never carries the payload.
- **`verify-events`** - a script you run (not something the application runs): it decodes stored events with the current definitions and reports the ones that cannot be read, the tags a definition derives that the stored event lacks, and event types in the log that no definition accounts for. Read-only; meant for CI against a copy of production. [Evolving events](./evolving-events.md#the-checks)
- **Change-impact report** - lists, for each model, which event types it handles, ignores or lacks, compared with a committed baseline whose entries need a reason. [Evolving events](./evolving-events.md#the-checks)
- **Tag-key table** - `crablet_event_tag_keys`: one row per event and tag key, which keeps the pollers' tag filters cheap. [ADR-0019](./adr/0019-storage-visibility-and-the-tag-table.md)
- **Storage report** - `storageReport()`: the sizes of the log and its indexes, also exposed as `crablet.storage.*` gauges. [Reference](./reference.md#operating-it)
