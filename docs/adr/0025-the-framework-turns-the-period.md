# ADR-0025: A model declares its period, and the framework turns it in the command's own append

## Status

**Accepted** (2026-10-09). Built: `Period` (`@crablet/commands/Period`: `year`, `month`, `day`, `custom`), `ModelBuilder.period`, `Loaded.prefix/boundary/guard`, the executor's append, `all` carrying them, `Scenario.at(date)`; the wallet runs on it (`WalletPeriodModel`). Tested in memory (`period.test.ts`) and on Postgres (`period-rollover.test.ts`, with the Effect clock moved between months). Design and measurements: [`docs/plans/period-rollover.md`](../plans/period-rollover.md), NOTES.md ("Closed periods").

## Context

A model scoped by a period (a wallet's statement, by month) needs a transition when a command arrives in a new period: close the previous one and open the new one with the state carried forward ("closing the books"). The wallet did it in a `prepare` step each command repeated: an append made BEFORE the command's own, outside the command's condition. Measured on the real wallet:

- the opening had no condition, so commands racing on a wallet each opened their own statement (179 openings for 60 wallets), and a later, stale opening reset the period's balance and **dropped the deposits before it**: 60 of 60 wallets ended with the wrong balance;
- a command that decided in a month and appended after another had turned the month wrote into the closed period, and the new period's opening balance, computed before it, never included it (115 in the current period instead of 122);
- a command that ended as an idempotent repeat committed what its `prepare` had appended, with no audit row (fixed separately: an idempotent result now rolls the transaction back).

Each was fixed by hand at the time, and each was the same mistake: the transition was written outside the path that makes a write consistent.

## Decision

The model declares the period once (`defineModel(...).period(Period.month, { opened, closed, open, close })`) and a command's model is built from the id alone (`Model.of({ id })`). On every load the framework:

1. reads the Effect `Clock` and the period "now" falls in;
2. if that period is open (its opening seen, its closing not), returns the state, and adds the closing of that period to the command's boundary (a commuting command gets it as a guard): a command that decided in a period that has closed since **conflicts**, retries, reads the clock again and lands in the new period;
3. otherwise reads the entity's open period and returns, besides the state, the events that turn it (`closed` for the old, `opened` for the new, built by the model's `close` and `open`), the wider boundary it read, and a cursor that is the EARLIEST horizon of its reads;
4. the executor appends `[...turn, ...the command's events]` in ONE append, strictly over that boundary, even for a commuting command - and only if the command has events of its own: a refusal, a no-op or an idempotent repeat never writes the turn.

Never turn a period back: if another pod's clock is behind, the command decides in the period that is open (counted by `crablet.period.clock_behind`). `decide` receives `{ now }` as its fourth argument: the instant the period was decided at (the clock, read once), so the timestamps a command stamps agree with the period, also under a test clock. Levels follow UTC, or the calendar of a zone when called with one (`Period.day({ timeZone })`, by `Intl.DateTimeFormat`); `Period.week` follows ISO weeks (or weeks from Sunday), the week belonging to the year that holds most of its days. An hour is not built (the tracking read grows with the number of periods; see the consequences); `Period.custom` takes the four functions of a level. `.lifecycle` keeps its meaning (an event not scoped by the period); it models no states or transitions, which stay in `decide`.

## Consequences

- The developer writes the period's `open` and `close` (and the fold of the opening), and no `prepare`, no resolver, no period tags by hand: `state.period.tags` carries them.
- A commuting command that turns the period is strict for that call: a conflict and a retry once per period per entity.
- The cursor MUST be the earliest horizon of the reads (a mutation of it fails six tests); using the last read's position would reopen the window between two reads of the same load.
- The tracking read (all openings and closings of the entity) grows with the number of periods; fine for month and day, not for an hour. Hours wait for a "last event that matches" read.
- Tests that move the Effect clock into the future must switch off the wake-up window (`wakeupMode: "off"`): it measures time with the same clock and schedules a timer for days.
- The events the turn builds are checked for the binding tag and the tags of the level, the first time a period is turned (a definition cannot say which tags an event declares without data): an opening that could not be found again would be opened again by every command.
- Not covered: events with period tags written by something that does not declare `.period`; an entity whose period was closed and never reopened is a defect (`die`), not a typed error.

## Alternatives considered

- **A point fix in the wallet** (the closing in the boundary, the resolver always closing): closes the window between the model load and the append, not the one between the resolver's read and the load, nor a pod with a late clock; tests showed which of the two stay open. Not done; the regression tests cover both.
- **A declarative state machine on the model**: consulted in `decide`, it writes no transition, so it does not make the turn atomic.
- **`decide` emitting the turn in each command**: works, and repeats the logic in every command of every model.
