# ADR-0039: A topic takes its publishers, and the feed takes views

## Status

**Accepted** (2026-10-20). Built: `defineTopic` (`@crablet/outbox/TopicConfig`), replacing `topicConfigOf`; `OutboxDeps.publishers` removed; the course
example's feed takes views. Tests: `topic-config.test.ts`, `outbox-processor-config.test.ts` (`publishersOf`), `outbox-integration.test.ts`. Follows
[ADR-0037](0037-the-declaration-api.md), which removed the same pattern from the views processor.

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
