# @crablet/outbox

A transactional outbox: events are published to something outside the database, **per topic**, from the same log and with the same delivery guarantees as views
(ordered, at-least-once, none skipped).

## What it gives you

- **`startOutboxProcessor`** (`/OutboxModule`) - runs the publishers, leader-gated, fed by the poller, owned by the Scope (`makeOutboxProcessor` builds without starting).
- **`OutboxPublisher`** - the one thing you implement: `publishBatch(events)` (or one event at a time, with `preferredMode: "individual"`). `makeLogPublisher` is a ready-made one that logs.
- **`defineTopic(name, { anyOfTags, publishers: [publisher] })`** (`/TopicConfig`), **`TopicPublisherPair`**, **`OutboxConfig`** - which events go to which topic, and the publishers themselves: the processor runs the publishers of its topics, so a topic cannot name one it does not have. `config` is optional: `OutboxConfig` is a partial of the shared [polling settings](../../docs/reference/configuration.md#polling-settings).
- **`OutboxManagementService`** - inspect and control topics.

A publisher must tolerate a repeat: after a crash, a publish that timed out (`publishTimeoutMs`, default 30 s) or a change of leader, an event is published
again. Give the destination `event.eventId` as the message id, so a broker that deduplicates by id drops the repeat; a consumer that keeps the order can
skip anything at or below the last `(transactionId, position)` it applied. A publisher with `preferredMode: "individual"` that fails part-way keeps what it
sent: the next attempt starts from the first event that failed ([ADR-0036](../../docs/adr/0036-outbox-delivery-event-id-timeout-and-partial-progress.md)).

## Depends on

[`@crablet/eventstore`](../eventstore/README.md), [`@crablet/event-poller`](../event-poller/README.md), `@crablet/metrics-otel`.

## Read more

[Delivery guarantees](../../docs/concepts/views-and-delivery.md); the [wallet example](../../examples/wallet-example-app/README.md) wires one.

Unit tests: `bun test packages/outbox/test/*.test.ts`. Integration tests (real Postgres through Testcontainers, needs Docker): `node --test "packages/outbox/test/integration/*.test.ts"`.
