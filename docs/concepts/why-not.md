# Why not something else?

*Concept · anyone choosing how to build a system with rules that must hold · the [README](../../README.md) read · 10 minutes*

The honest question before adopting this is whether you need it. This page compares it with the two things people usually use instead, and says when
those are the better choice.

## Why not a database transaction?

The rule from the README, done with plain tables:

```sql
BEGIN;
SELECT capacity, subscribers FROM courses  WHERE id = 'math' FOR UPDATE;
SELECT count(*)              FROM enrolments WHERE student_id = 'ann';   -- and lock ann's row, so two of her requests cannot race
-- check both rules in the application, then:
INSERT INTO enrolments (student_id, course_id) VALUES ('ann', 'math');
UPDATE courses SET subscribers = subscribers + 1 WHERE id = 'math';
COMMIT;
```

This works, and **for many systems it is the right answer.** If the current state is all you need, use it. `SERIALIZABLE` isolation can replace the
explicit locks, at the cost of retrying transactions that conflict.

What this project adds on top of "check and write in one transaction":

| You get | With tables and locks |
|---|---|
| **The history is the source of truth.** Every decision is recorded as a fact (`StudentSubscribed`), and new read models can be built from it later. | The current state only, unless you also write an audit table, and keep it consistent by hand. |
| **The boundary comes from the decision.** A command declares which facts it depends on; the framework derives the query and the conflict check. No lock ordering, no deadlocks between commands. | You choose which rows to lock, in which order, in every command, and review that it is still right when a rule changes. |
| **Decisions are pure functions.** `decide` takes state and input and returns events or a refusal; tests run without a database. | The rule is usually mixed with the SQL that loads and locks. |
| **What reacts to a write is reliable.** Views, automations and an outbox read the same log, with no event skipped, causal order, at-least-once delivery, views that apply each event once, and a leader fenced by its cursor ([views and delivery](./views-and-delivery.md)). | You add triggers, a queue or polling, and their delivery guarantees are yours to design. |
| **Reads that include your write**, by a marker, or a `503` ([reading your own writes](./read-your-writes.md)). | Usually free, because you read the same tables, until you add read replicas or caches. |

**Choose tables and transactions** when you do not need the history, have few cross-entity rules, and nothing important reacts to writes.
**Choose this** when the facts matter in themselves (money, enrolments, bookings, anything audited), when several things react to each write, or when
rules span things that a fixed lock layout makes awkward.

## Why not an event store with streams?

Most event-sourcing tools organise events in **streams**, usually one per aggregate (one course, one student). A stream has a version, and an append
says "only if the stream is still at version N". That protects one stream well. The difficulty is a rule that spans streams, like the README's: the
course's stream and the student's stream each have a version, and "subscribe" must respect both.

The usual answers are to make one aggregate own the decision and enforce the other rule after the fact (a saga or a process manager that may have to
compensate), or to redesign the aggregates so that one stream holds both rules (often a large, contended stream). Either way, the consistency
boundary is fixed when you design the streams, and changing a rule can mean changing the stream layout.

With **dynamic consistency boundaries** there are no streams. An event is tagged with everything it concerns (`StudentSubscribed` with both the course
and the student), and each command's boundary is the set of events its decision reads, chosen per command. The append condition is "nothing newer in
*this* boundary". So:

- a rule over two things is one atomic decision, without a saga;
- two commands conflict only when one changes what the other read, so there is no large contended stream;
- adding a rule changes a command's boundary, not the storage layout.

The price is that you think in facts and tags instead of in aggregates, which is a real change for a team used to aggregates. The
[DCB guide](./dcb-guide.md) works through a transfer and the course example in detail, with tests that force the races.

## What this is, precisely

An implementation of the open [DCB specification](https://dcb.events/specification/) for TypeScript, on [Effect](https://effect.website) and
PostgreSQL, plus what an application needs around it: a typed command API, views, automations, an outbox, an HTTP layer with OpenAPI, and the tools
to run it. How its append conditions map onto the specification, and what it adds (idempotency), is in
[the DCB guide](./dcb-guide.md#how-this-relates-to-the-dcb-specification). Other implementations of the specification are listed at
[dcb.events](https://dcb.events/).

## What you take on if you adopt it

Choosing this means accepting costs a plain database does not have:

- **A pre-release dependency.** No stability promise yet, and no npm package: you work from a clone of this repository ([roadmap](../../ROADMAP.md#before-a-10)).
- **Effect.** The API is written in Effect's terms. Defining events, models and commands needs little of it, but wiring and running an application is Effect code, and so is your own
  integration with it ([FAQ](./faq.md#do-i-need-to-know-effect)).
- **A different way to model.** You think in facts and the tags they are found by, not in tables or aggregates, and your team has to learn that.
- **Background processes to run.** Views, automations and the outbox run as processors with a leader, a cursor and a lag; you monitor them and answer their alerts
  ([operate](../guides/operate/runbooks.md)). A transaction has none of this.
- **A log that only grows.** Events are never deleted, and erasing a person's data from it is not built yet ([events over time](./events-over-time.md)).
- **One database engine.** PostgreSQL, including its advisory locks and `LISTEN`, if you want the background processors to fail over.

## When not to use it

- **You need a stable library now.** This is pre-release; the API changes often and the packages are not on npm.
- **You are not on PostgreSQL.** It is the only store, and the design relies on its transactions, advisory locks and `LISTEN`.
- **Your team does not want Effect.** Defining events, models and commands needs little of it, but wiring and running an application is Effect code
  ([FAQ](./faq.md#do-i-need-to-know-effect)).
- **You must erase personal data from history today.** See [events over time](./events-over-time.md#personal-data).
