# ADR-0036: Outbox delivery: a stable event id, a publish timeout, and partial progress

## Status

**Accepted** (2026-10-18). Built: migration `V18__crablet_event_id.sql` (`crablet_events.event_id`, a uuidv7, no index), `StoredEvent.eventId`,
`OutboxConfig.publishTimeoutMs` (default 30 s), `HandledPrefix` (`@crablet/event-poller/EventHandler`), and the outbox publisher contract. Tests:
`migration-v18.test.ts`, `sql-event-fetcher.test.ts` (the poller reads the stored id), `outbox-event-handler.test.ts` (timeout, partial progress),
`event-processor-loop.test.ts` (the cursor keeps a handled prefix).

## Context

The outbox is at-least-once (ADR-0023): its effect is outside the database. Three things made repeats and stalls more likely than they had to be, and gave a
consumer little to deduplicate with.

1. **No stable id for the sink.** The contract said to deduplicate on `event.position`. That is unique inside one store, but it changes if the log is ever
   copied to another store, and it is not an id a broker can use as a message id.
2. **No time limit on a publish.** A destination that hung held its topic back for good: the leader kept its lock, the heartbeat kept passing, and nothing
   failed.
3. **A failure part-way through a batch republished all of it.** In `individual` mode a failure at event k sent events 1..k-1 again.

## Decision

**A stored event id.** Every event gets `event_id uuid NOT NULL DEFAULT uuidv7()`, with no index, and every `StoredEvent` carries it as `eventId`. It is the
event's stable public identity: the same on every republish and in every copy of the log. The contract tells a publisher to give it to the destination as the
message id, so a broker that deduplicates by id drops a repeat (SQS FIFO `MessageDeduplicationId`, NATS `Nats-Msg-Id`, Azure Service Bus `MessageId`, a
CloudEvents `id`).

- **It is not an order.** A uuidv7 sorts by when it was generated, not by `(transaction_id, position)`. A consumer that keeps the order it receives can skip
  anything at or below the last `(transactionId, position)` it applied, saved together with what it applied: each publisher's stream is in that order, and a
  repeat only goes back to where the cursor last stood (ADR-0032). A consumer that does not keep the order keeps the set of ids it has seen.
- **No index.** Nothing looks an event up by id yet. An index can be added with `CREATE INDEX CONCURRENTLY` when something does, for example lookup by id or ids
  supplied by the writer, which would need uniqueness enforced.

**A publish timeout.** Each call to `publishBatch` may take at most `publishTimeoutMs` (default 30 s). A timeout is a handler error, counts toward `maxErrors`,
and the batch is published again. A timed-out publish may still have reached the destination, which at-least-once allows.

**Partial progress.** A handler can fail with `HandledPrefix { handled, cause }`: the first `handled` events of the batch were handled for good. The processor
moves the cursor past them, with the same compare-and-set as a normal move (ADR-0032), records `cause`, and fails the tick. The next tick starts from the first
event that was not handled. The outbox's `individual` mode reports it. A view's batch is all or nothing and never uses it.

An event that keeps failing still stops its processor (`FAILED`) after `maxErrors`. Order and no gaps win over availability; the runbook says how to recover.

## Consequences

- **Storage, measured** (`storage.diagnostic.ts` E9a, `SCHEMA=current`, 200,000 wallet-shaped events, one laptop, one run): the events heap went from 409 to
  415 bytes per event (alignment padding absorbs most of the 16 bytes of a uuid), and the log as a whole from 1,247 to 1,252 bytes per event (+0.4 %). The
  append rate was the same within noise (10,544 and 10,698 events/s).
- **Migration.** Adding the column rewrites `crablet_events` under an exclusive lock: fine for a young log. The migration's header gives the batched path for a
  large one.
- `HandledPrefix` is plumbing (`@crablet/event-poller` is internal, ADR-0031); applications see its effect, fewer repeats.

## Alternatives considered

- **An id derived from the position at publish time** (`uuidv5(namespace, position)`). It costs nothing, but it changes if the log moves to another store,
  which is exactly when a sink most needs the same id.
- **A unique index on `event_id`.** About 50 bytes per event more (estimated). Deferred until something needs lookup by id.
- **A random id generated when publishing.** Rejected: a repeat would get a new id and look like a different message.
- **Skip a poison event** (a dead-letter table). Rejected: it breaks "no event skipped" and the order. `FAILED` and the runbook stay.
