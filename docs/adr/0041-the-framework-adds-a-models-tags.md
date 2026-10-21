# ADR-0041: The framework adds the tags a command's own model reads its events by

## Status

**Accepted** (2026-10-20). Built: `Loaded.complete` (`@crablet/commands/Model`), replacing `Loaded.misses`, and the executor's use of it
(`@crablet/commands/Command`); `PeriodSpec.key` as a method. Tests: `period.test.ts` ("an event the command's own model reads back"). Amends
[ADR-0037](0037-the-declaration-api.md), which refused such an event.

## Context

A model with a `scope` or a `.period` reads its events by tags the events do not declare themselves (year and month, say): the command adds them
when it appends. ADR-0037 made a missing one a defect at append time, because an event without them is missed by the next load and by the boundary.
That closed the hole, but every command still built the tags by hand (`DepositMade(data, [...wallet.period.tags, ...])`, `...from.period.tags` in a
transfer), and the only thing that could go wrong was forgetting them, which the executor had just found, with their values.

Separately, `Period.month` could not be used where a wider period type was expected (the wallet picks month or N minutes at start-up) without
`as unknown as`: `PeriodSpec.key` was a function-typed property, so its parameter was checked contravariantly.

## Decision

- **The executor adds the missing tags.** For each event the command's own model handles, about its entity, the tags the model reads it by (its
  scope, the period it decided in) that the event does not carry are added before the append, and before `byModel()`'s check, so the event that is
  checked is the one that is written. Each member of `all(...)` adds its own.
- **A tag carried with another value is still refused**, as a defect, and nothing is appended: a deposit tagged with last month, or two members of
  `all(...)` that want one key with different values, is a mistake the framework cannot correct.
- **`state.period.tags` stays**, for an event the command's model does not read (one for another model, or a lookup's), which is not completed.
- **`PeriodSpec.key` is a method**, so it is checked bivariantly. The framework only calls it with fields the spec's own `fieldsAt` or `fieldsOf`
  made, so a narrower spec can stand for a wider one.

## Consequences

- A command no longer writes a model's scope or period tags. The wallet's commands add only the statement id (a tag for its views).
- Code that already added them is unchanged: a tag present with the right value is left alone.
- The tags an event is stored with are no longer all visible in `decide`; the log, `ModelImpact` and the scenario's `events` show them.

## Alternatives considered

- **Keep refusing** (ADR-0037). Rejected: the refusal knew the fix and asked the developer to type it.
- **Add the tags to every event a command appends.** Rejected: an event about another entity, or one the model does not read, is not in the model's
  scope, and tagging it would put it in a period it was not decided in.
