# @crablet/outbox

A transactional outbox: events are published to something outside the database, **per topic**, from the same log and with the same delivery guarantees as views
(ordered, at-least-once, none skipped).

## What it gives you

- **`startOutboxProcessor({ topics, publishers })`** (`/OutboxModule`) - runs the publishers, leader-gated, fed by the poller, owned by the Scope. `publishers` has one `OutboxPublisher` per name the topics give: a missing name does not compile. `makeOutboxProcessor({ topics })` builds without starting and without publishers (a handle for status and the admin API); starting such a handle by hand needs `OutboxPublishers` provided.
- **`OutboxPublisher`** - the one thing you implement: `publishBatch(events)` (or one event at a time, with `preferredMode: "individual"`). `makeLogPublisher` is a ready-made one that logs.
- **`defineTopic(name, { anyOfTags, publishers: ["kafka"] })`** (`/TopicConfig`), **`TopicPublisherAssignment`**, **`OutboxConfig`** - which events go to which topic, and the names of its publishers (or `{ publisher: "kafka", pollingIntervalMs }`, a `TopicPublisherAssignment`, to give one its own polling settings). A name keys its progress row with the topic's; the declaration holds no publisher, so a process that only lists the processors builds none ([ADR-0039](../../docs/adr/0039-a-topic-takes-its-publishers.md), amended). `config` is optional: `OutboxConfig` is a partial of the shared [polling settings](../../docs/reference/configuration.md#polling-settings).
- **`OutboxManagementService`** - inspect and control topics.
- **`TopicPublisherPair`** (`/TopicPublisherPair`) - a topic and one of its publishers, and `toKey`/`fromKey`, the JSON pair a publisher's processor is identified by (in the admin API, say).

A publisher must tolerate a repeat: after a crash, a publish that timed out (`publishTimeoutMs`, default 30 s) or a change of leader, an event is published
again. Give the destination `event.eventId` as the message id, so a broker that deduplicates by id drops the repeat; a consumer that keeps the order can
skip anything at or below the last `(transactionId, position)` it applied. A publisher with `preferredMode: "individual"` that fails part-way keeps what it
sent: the next attempt starts from the first event that failed ([ADR-0036](../../docs/adr/0036-outbox-delivery-event-id-timeout-and-partial-progress.md)).

## Depends on

[`@crablet/eventstore`](../eventstore/README.md), [`@crablet/event-poller`](../event-poller/README.md), `@crablet/metrics-otel`.

## Read more

[Delivery guarantees](../../docs/concepts/views-and-delivery.md); the [wallet example](../../examples/wallet-example-app/README.md) wires one.

Unit tests: `bun test packages/outbox/test/*.test.ts`. Integration tests (real Postgres through Testcontainers, needs Docker): `node --test "packages/outbox/test/integration/*.test.ts"`.
