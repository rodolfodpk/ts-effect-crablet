# ADR-0021: Wake-ups are sent after the commit and coalesced, not inside every append

## Status

**Proposed** (2026-10-08). Nothing is built. The evidence below comes from `pgbench` runs against `postgres:18.6-alpine`, with a prototype that is a separate notifier connection, not code in this repository. The decision is to be accepted when the tests in "Before accepting" exist and pass.

## Context

Every append calls `pg_notify` from inside `append_events_if()`, in the append's own transaction (`EventStore.ts` passes `notifyChannel` and an `encodePayload(types, tagKeys)` payload; ADR-0005). The notification is delivered at commit, and that is the cost: Postgres serializes the commit of transactions that notify, so notifying appends queue behind each other however many clients there are.

**Measured** (`pgbench`, 32 clients, one event per append, a distinct tag per transaction so no append waits on another's advisory lock; one laptop under Docker, so the ratios matter more than the absolute numbers, and the same run varied between 2.0k and 3.6k tps):

| 32 clients | tps | average latency |
|---|---|---|
| `pg_notify` in every append (today) | 2.0k to 3.6k | 9 to 16 ms |
| no `pg_notify` in appends | 9.1k to 12.2k | 2.6 to 3.5 ms |
| no `pg_notify` in appends, plus **one** separate notifier connection at 20 notifications/s | 8.98k (2 % below the line above, same run) | 3.6 ms |
| the same, notifier at 100 notifications/s | 8.80k (4 % below) | 3.6 ms |

The scripts are three lines each (`SELECT append_events_if(ARRAY['Deposited'], ARRAY['{"wallet_id=w' || :id || '"}'], ARRAY['{}'::jsonb] [, p_notify_channel => 'crablet_events', p_notify_payload => 'x'])` with `\set id random(1, 100000000)`, and `SELECT pg_notify('crablet_events', 'x')` run with `pgbench -R` for the notifier). With one client the difference is nil (2.1k against 2.4k tps); it appears as concurrency does (8 clients: 4.0k against 8.5k). So the notification caps the write path at roughly 2 to 4 thousand appends a second per database, a ceiling that adding clients or cores does not raise.

**The mechanism, observed.** Sampling `pg_stat_activity` every half second during the 32-client runs, the active append sessions with `pg_notify` in the append were waiting on `Lock / object` in 476 of the 508 samples that showed a wait (the heavyweight lock Postgres takes on a database object while a notifying transaction commits), against `LWLock / WALWrite` (ordinary write-ahead-log contention) in the run without it, where no session waited on that lock.

Three facts about the code decide what can be done:

- **The wake-up is only a hint.** Delivery is guaranteed by the cursor (`(transaction_id, position)`, ADR-0012) and a poll; a lost notification delays an event and never loses one. ADR-0005 and the pollers already rely on this: on a reconnect the listener emits a wildcard.
- **An idle poller depends on it.** `EventProcessor` backs off after empty polls, up to `backoffMaxSeconds` (120 s in the wallet example), and a notification is what wakes it early. Removing the notification without a replacement would add up to two minutes of latency after a quiet spell.
- **The receiving side already coalesces.** `Listen.ts` groups the notifications a listener receives within 20 ms (`DEBOUNCE_MS`, ADR-0005) into one dispatch carrying the union of types and tag keys, and `shouldWake` (in `NotifyPayload.ts`) filters a dispatch per processor in memory. The payload is a set of event types and tag keys, capped at 7 900 characters with a `*` fallback.

The view-progress pings (ADR-0014, ADR-0016) use the same mechanism in the same statement as the cursor update, but they are sent once per processed batch, not once per append, so they are not the bottleneck and are out of scope here.

## Decision

1. **Appends stop notifying.** `EventStore.append` no longer passes `notifyChannel` and `notifyPayload` to `append_events_if()` (the SQL parameters stay, optional and unused: no migration). Instead it records the event types and tag keys of what it appended in a small **wake-up notifier** owned by the event store service.
2. **The notifier coalesces and sends after the commit.** Per process it keeps the union of the types and tag keys recorded since the last notification and sends **one** `SELECT pg_notify(channel, encodePayload(union))` in its own short transaction, through the `SqlClient` the event store already holds (`PgClient.notify` also takes a dynamic payload on the Effect version in use, as the comment in `Listen.ts` says; the workaround ADR-0005 describes belongs to an older version) when told the commit has happened:
   - **leading edge**: if nothing was sent in the last `wakeupWindowMs`, it sends at once, so an idle system adds no latency;
   - **trailing edge**: otherwise it sends when the window ends, with everything recorded meanwhile. At most one notification per window per process.
   - A union may wake a processor that none of the events matches; it never wakes fewer than the events require, because every processor's filter is evaluated against a superset of each append's types and keys. A wasted wake-up costs one empty poll.
3. **"After the commit" is the framework's job where it owns the transaction.** `CommandExecutor` runs the append inside `sql.withTransaction`, so the executor asks the notifier to flush **after** the transaction has committed (and after a retried attempt succeeded; an attempt that rolled back may leave a stale entry, which causes at most a wasted wake-up). An `append` made outside any transaction flushes when it returns. An application that calls `EventStore.append` inside a transaction of its own must call the flush itself after its commit; the docs say so. A flush before the commit would be worse than no notification (the poller wakes, sees nothing, sleeps).
4. **Configuration.** `wakeupWindowMs` (default 50). `0` sends after each commit without waiting (the notification is still outside the append). A compatibility mode, `wakeupMode: "inline"`, keeps today's behavior (`pg_notify` inside the append) so a deployment that depends on it, or wants to compare, can keep it. The default becomes the coalesced mode only once the tests below exist.
5. **Metrics.** Counters for notifications recorded, notifications sent and notifications saved by coalescing (`crablet.eventstore.wakeups_*`), so the effect is visible on the dashboard and a stuck notifier is noticeable.
6. **Bound the idle backoff, separately.** The notification can now be lost in one more way (the process dies between the commit and the flush). The pollers' idle backoff should have a short documented maximum (the order of 5 to 10 seconds) so the worst case is bounded, instead of the 120 s the examples use. Changing the defaults is a separate decision and is listed under "Follow-ups"; this ADR only requires that the docs state the trade.

## Alternatives considered

- **A switch that turns the in-append notification off.** The smallest change and a fine escape hatch, and the compatibility mode in decision 4 is exactly that. Alone it trades latency for throughput: with the backoff at 120 s the pollers would be slow to see events after a quiet spell. Rejected as the *answer*, kept as a mode.
- **Do nothing and document the ceiling** (2 to 4 thousand appends per second per database). Free, and enough for most users, but the limit stays invisible until someone meets it. Rejected, though the measurement and the ceiling belong in the docs either way.
- **A separate notifier that polls `max(position)`** and notifies when it moves. It decouples writers completely but adds a poll loop with the same latency bound as the window, and a second source of "something changed". No advantage over a notifier fed by the appends themselves.
- **Listen to the WAL (logical decoding) instead of polling or notifying.** Measured on the same image with `wal_level=logical`: appends ran at 11.4 to 11.6k tps with a slot being read (about 9 % below the same run without a slot), so the wake-up cost disappears, and the stream is in **commit order** (in 278 thousand transactions, 39 780 events arrived with a `position` lower than one already delivered, the reordering the `(transaction_id, position)` cursor exists for). It is not a replacement: a slot cannot go back, so rebuilding a view and starting a new processor still need the table read and a consistent handover to the stream; the append conditions still use the `(xid, position)` cursor; `wal_level=logical` needs a restart and a managed service that allows it; an unread slot **retains WAL without limit by default** (`max_slot_wal_keep_size = -1`; 145 MB retained in 12 seconds of writes with the consumer stopped); every slot decodes the whole WAL; the replication protocol has no library in the stack; and it does not beat this ADR on throughput (about 91 % of the no-notification line with a slot being read, against 96 to 98 % for the notifier; different runs, so only the order of magnitude is comparable), so the cost above buys nothing here. Kept as a possible opt-in later (an event source for deployments that need more than about 10 thousand appends a second, sub-10 ms wake-ups, or external CDC consumers), most likely through an existing tool feeding the outbox.

## Consequences

- The append no longer waits in the notification queue. At 32 clients the prototype recovered 96 to 98 % of the no-notification throughput; the real figure will be measured with the implementation (see "Before accepting").
- A wake-up now costs up to `wakeupWindowMs` of added latency under load and none when idle. Pollers already tolerate this: they also wake on their own interval.
- At most `1 / window` notifications per second per process reach Postgres (20 a second for the default). With ten instances that is 200 a second in total, against thousands today.
- Correctness does not change. A notification only wakes; the cursor decides what is delivered. A lost or spurious wake-up changes latency, not the events a processor sees.
- New moving part: the notifier, with its own tests, and an obligation on code that appends inside its own transaction (decision 3). The risk is a flush placed before a commit; the integration test below exists for it.
- Appends made by tools outside the framework (a SQL script) never notified through the notifier, as before when they passed no channel; pollers see them by polling.
- The view-progress pings keep their in-statement `pg_notify` (per batch).

## Before accepting

- A unit test with `TestClock` for the notifier: the first signal after idle is sent at once; later signals within the window are merged into one notification whose payload is the union; nothing is sent when nothing was recorded; a signal recorded during a send is not lost.
- An integration test (real Postgres) that **no wake-up is lost**: many concurrent commands, each followed by a wait for the processor to handle its event within the window plus a poll interval, with the idle backoff set high enough that a missing wake-up would show as a timeout; and a test that the flush happens after the commit (a processor must find the event when it wakes).
- The existing wake-up and listener tests (`listen-reconnect`, `notify-payload`, `event-processor-loop`, `view-progress-hub`) pass unchanged in the compatibility mode.
- The `pgbench` comparison of the prototype above is repeated against the implementation, with the scripts committed under `packages/eventstore/diagnostics/`, and the result written back into this ADR.
- The dashboard has panels for the three new counters, and `scripts/dashboard.test.ts` declares their labels.

## Follow-ups (not decided here)

- Lower the default idle backoff of the examples and document `backoffMaxSeconds` as a latency bound when notifications can be lost (decision 6).
- The same treatment for the view-progress pings if a deployment ever batches so fast that they matter.
- A documented ceiling (about 2 to 4 thousand appends a second per database with in-append notification, on the hardware measured) in the operating docs, whichever way this goes.
- The logical-decoding event source, if a deployment needs it.
