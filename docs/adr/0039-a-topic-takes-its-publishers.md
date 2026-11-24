# ADR-0039: A topic takes its publishers, and the feed takes views

## Status

**Accepted** (2026-10-20). Built: `defineTopic` (`@crablet/outbox/TopicConfig`), replacing `topicConfigOf`; `OutboxDeps.publishers` removed; the course
example's feed takes views. Tests: `topic-config.test.ts`, `outbox-processor-config.test.ts` (`publishersOf`), `outbox-integration.test.ts`. Follows
[ADR-0037](0037-the-declaration-api.md), which removed the same pattern from the views processor.

**Amended** (2026-11-23, the maintainer's decision, phase 2a of the `@crablet/app` plan): **a topic names its publishers again, and the compiler checks the
names.** `defineTopic(name, { publishers: ["kafka"] })` keeps the names as literal types, and `startOutboxProcessor({ topics, publishers: { kafka } })`
takes one publisher per name: a missing name does not compile, and neither does a publisher no topic names (`test/topic-publishers.types.ts`). The
mistake this ADR removed (a name with no publisher, found at run time) stays impossible, now by type rather than by holding the objects.

Why: a process that only lists and controls the outbox's processors (an API serving the admin, ADR-0022) needs the declaration, and with publishers in it
that process had to build a client for the broker it never uses. The declaration now holds no publisher, and `makeOutboxProcessor({ topics })` needs only the
SQL client; the publishers are what running needs (`OutboxPublishers`, provided by `startOutboxProcessor`). **One name is one publisher** by construction:
the name is the record's key, and `OutboxPublisher` lost its `name` field, so a name has one source. Breaking (pre-release, ADR-0013): `defineTopic` takes
names, `OutboxPublisher.name` and `publishersOf` are removed, `startOutboxProcessor` takes `publishers`. The wallet keeps the name `LogPublisher`, so its
progress rows carry on.

## Context

ADR-0037 made the processors take what was declared, because two lists that must agree by name drift. The outbox kept such a pair: a topic named its
publishers (`topicConfigOf("wallet-events", { publishers: ["LogPublisher"] })`) and the processor took the publishers in a second list. A name in the
first that was missing from the second compiled, built, and then failed every batch of that pair at run time (`Unknown publisher`).

The course example's live-update feed was configured with view names (`views: [COURSE_SEATS_VIEW]`) next to consistent reads that take the views
(`reads: [CourseSeatsView]`).

## Decision

- **`defineTopic(name, { ...selection, publishers })` takes the `OutboxPublisher`s themselves** (or `{ publisher, ...overrides }` for one with its own
  polling). The processor runs the publishers of its topics; `makeOutboxProcessor({ topics })` no longer takes `publishers`.
- **One name is one publisher.** Progress is kept per (topic, publisher name), so two different publisher objects under one name are refused when the
  processor is built. The same publisher on several topics is one publisher.
- **The course feed takes views**, as a consistent read does. A request still names them (`?views=course-seats-view`), so the name stays shared with the
  browser in `CourseApi.ts`.

## Consequences

- **Breaking.** `topicConfigOf` and `OutboxDeps.publishers` are removed, with no alias (pre-release, [ADR-0013](0013-api-evolution-additive-vs-breaking.md)).
- A topic cannot name a publisher the processor does not have: the mistake no longer exists.
- Names that key progress are unchanged: the topic's and the publisher's. Existing cursors carry on.

## Alternatives considered

- **Keep the names and check them against the list when the processor is built.** Catches the mistake, but keeps two lists to keep in agreement.
- **Make the name the first argument of every `define*`, including `defineCommand`.** Not done: a command's name comes from its contract, spread into
  `defineCommand` so the input schema is written once (ADR-0037), and a positional name would have to be repeated beside it.
