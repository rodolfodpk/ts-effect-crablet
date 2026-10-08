# @crablet/outbox

A transactional outbox: events are published to something outside the database, **per topic**, from the same log and with the same delivery guarantees as views
(ordered, at-least-once, none skipped).

## What it gives you

- **`makeOutboxProcessor`** (`/OutboxModule`) - runs the publishers, leader-gated, fed by the poller.
- **`OutboxPublisher`** - the one thing you implement: `publishBatch(events)` (or one event at a time, with `preferredMode: "individual"`). `makeLogPublisher` is a ready-made one that logs.
- **`TopicConfig`**, **`TopicPublisherPair`**, **`OutboxConfig`** - which events go to which topic and publisher.
- **`OutboxManagementService`** - inspect and control topics.

A publisher must be idempotent: after a crash an event can be published again.

## Depends on

[`@crablet/eventstore`](../eventstore/README.md), [`@crablet/event-poller`](../event-poller/README.md), `@crablet/metrics-otel`.

## Read more

[Reference: delivery guarantees](../../docs/reference.md#views-the-outbox-and-automations); the [wallet example](../../examples/wallet-example-app/README.md) wires one.

Unit tests: `bun test packages/outbox/test/*.test.ts`. Integration tests (real Postgres through Testcontainers, needs Docker): `node --test "packages/outbox/test/integration/*.test.ts"`.
