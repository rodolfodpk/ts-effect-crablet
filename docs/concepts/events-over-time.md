# Events over time: change, personal data and growth

*Concept · anyone deciding whether to keep facts for years · the [README](../../README.md) read · 10 minutes*

Events are never updated or deleted. That is what makes the log trustworthy, and it raises three questions an adopter should ask early: how does an
event change shape, what about personal data, and what happens as the log grows? This page answers each one, including what is not solved yet.

## Changing an event

The log holds every shape an event was ever written in, and today's code must read all of them. The rule:

> A new shape of an event keeps its name only if it can be **built from every older shape**. Anything else is a **new event with a new name**.

So adding a field with a default, or an optional field, keeps the name. Renaming, removing or retyping a field, or changing what a tag means, is a new
event. There are no upcasters and no version column.

You decide whether a change is compatible; the framework detects a mistake. A stored event that the current definition cannot read fails with a typed
`EventDecodingError`. It is never skipped and never silently misread. Three checks catch mistakes before production does: fixtures of old payloads, a
change-impact report of what each model handles, and `verify-events`, a script that decodes a copy of production data. The steps, with tested code, are
in [Evolving events](../guides/build/evolving-events.md); the decision is [ADR-0017](../adr/0017-event-evolution-by-compatibility.md).

DCB adds one thing to watch: a model's boundary is built from the event types it handles, so a *new* event type that carries a model's tags must be
handled or explicitly ignored by that model. The change-impact report lists them.

## Personal data

| | Today |
|---|---|
| **Tags** | Stored as plain, indexed text. **They cannot be erased or redacted.** Put opaque ids in tags (`student_7f3a...`), never names or emails. Building an event whose tag repeats a value marked personal fails. |
| **Payload fields marked `personal(...)`** | Redacted in the command audit, masked by the event log API, and flagged `x-personal` in the OpenAPI description. Mark a field once, in its schema. |
| **Erasing a person's data from the log** | **Not built.** The payload is stored as written. Encrypting personal fields so their key can be destroyed (crypto-shredding) is planned, not available. |

If you must be able to erase personal data on request, keep it outside the log today (in a table you own, referenced by an opaque id), or wait for
crypto-shredding. `personal(...)` is in `@crablet/commands/Domain` (and `/Personal`, for a contract a browser imports); the [tutorial](../tutorial/01-the-rule-in-memory.md) shows it in context.

## Growth

Nothing deletes events, and **retention is not decided** ([ADR-0019](../adr/0019-storage-visibility-and-the-tag-table.md)). What exists instead is
visibility:

- `storageReport()` and the `crablet.storage.*` gauges report the size of the log and its indexes, and the bytes per event.
- The tag-key table keeps the pollers' tag filters cheap as the log grows.
- A command reads only the events in its boundary, through indexes on tags, so its cost follows the size of its boundary, not of the log.

Plan for the log to grow for as long as the application runs, and watch the gauges ([Monitor it](../guides/operate/monitor-it.md)). A boundary that
grows without end (every event of a busy account, for years) makes that command slower; a model that turns over by period keeps it bounded
([Turn a period](../guides/build/turn-a-period.md)).

## Decisions behind this page

[ADR-0017](../adr/0017-event-evolution-by-compatibility.md) (evolution by compatibility) · [ADR-0019](../adr/0019-storage-visibility-and-the-tag-table.md) (storage and retention) ·
[ADR-0025](../adr/0025-the-framework-turns-the-period.md) (periods)
