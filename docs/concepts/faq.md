# Questions adopters ask

*Concept · anyone evaluating the project · the [README](../../README.md) read · 10 minutes*

Short answers, each with a link to the full one. Where something is not built or not decided, the answer says so.

## Do I need to know Effect?

Some. Defining events, models and commands (`defineEvent`, `defineModel`, `defineCommand`) uses Effect's `Schema` for payloads and inputs, and little
else; `decide` is a plain function. Tests written with `given(...)` are plain `async` code. Wiring an application, running commands and adding views are
Effect code (`Effect.gen`, layers). Clients of your application need none of it: they call a REST API described by a generated OpenAPI document. The
[tutorial](../tutorial/README.md) shows each part; Effect's own documentation is at [effect.website](https://effect.website).

## Is it ready for production?

Not as a dependency you install. It is **pre-release**: the API changes often, breaking changes are accepted when they are worth it
([ADR-0013](../adr/0013-api-evolution-additive-vs-breaking.md)), and the packages are not on npm. The engineering is meant for production: what is
guaranteed, how each guarantee is tested and what was measured under failure is in [the evidence](../evidence.md).

## Which databases does it support?

PostgreSQL only (the tests run on Postgres 18). The design relies on its transactions, advisory locks and `LISTEN`/`NOTIFY`. It works behind a
connection pooler in transaction mode if the leader locks and listeners get a direct connection
([behind a pooler](../guides/operate/run-in-production.md#behind-a-pooler-pgbouncer-rds-proxy)).

## How fast is it, and how big does the log get?

Measured on one laptop with Docker, so for order of magnitude only: loading a million events through the append path ran at about 15,000 events per
second, and an event with a few tags takes about 1.2 KB with its indexes. A command reads only the events in its boundary, so its cost follows the
size of its boundary, not of the log. The numbers and how firm each one is are in [the evidence](../evidence.md#numbers).

## What about personal data and GDPR?

Tags cannot be erased, so they must hold opaque ids, never names or emails. Payload fields marked `personal(...)` are redacted in the audit and
flagged in the API description. **Erasing a person's data from the log is not built yet** (crypto-shredding is planned). Today, keep data you may have
to erase outside the log. Details: [events over time](./events-over-time.md#personal-data).

## Does the log grow for ever?

Yes, today. Nothing deletes events and retention is not decided. Storage is visible (a report and gauges), and models that turn over by period keep
long-lived boundaries small. See [events over time](./events-over-time.md#growth).

## Can I adopt it in an existing application?

Yes, one part at a time, because it lives in your PostgreSQL database next to your own tables. A reasonable first step is one new feature whose rules
span several things, with its own events and a view your existing code can read as an ordinary table. Commands, views and the HTTP layer are separate
packages, so you take only what you use. There is no tool that turns existing tables into events; if you need the history of existing data, you
write the events that describe its current state yourself, with the event store's own API ([use the event store directly](../guides/build/use-the-event-store-directly.md)).

## Can I use only the event store, without commands?

Yes. `@crablet/eventstore` has the specification's API on its own: read a page or a stream of events, read to decide, and append after that
read (`decision.append`), with the same conflict check commands have. What a command adds (retries, a repeat
recognised, the audit, the HTTP endpoint) you then write yourself. See [use the event store directly](../guides/build/use-the-event-store-directly.md).

## Does it support several tenants?

There is no tenant concept in the framework. A tenant id can be a tag on every event and part of every model's identity, so boundaries never cross
tenants; isolating tenants at the database level (a database or schema per tenant) is up to the application.

## How do I change an event that is already stored?

Keep the name only for compatible changes (a field with a default, or an optional field); anything else is a new event. Checks catch mistakes before
deploying. See [Evolving events](../guides/build/evolving-events.md).

## What happens when an instance dies?

Each module's background work runs on one leader, chosen by a PostgreSQL lock. If the leader dies, another instance takes over within the retry interval
(5 seconds by default); a leader that loses its database session stops before handling anything more. Nothing is skipped. See
[background processors](./background-processors.md) and [the evidence](../evidence.md).

## Why not just use a transaction, or an event store with streams?

See [Why not something else?](./why-not.md)
