# ADR-0028: The framework decides the wake-up settings it can work out itself

## Status

**Accepted** (2026-10-11). Built: `wakeupMode: "inline"` is removed, and the views, automations and outbox modules follow the event store's wake-up
mode through a `Wakeups` reference that `makeEventStoreLayer` provides; `listenForWakeups` is removed. Narrows [ADR-0021](0021-wakeups-after-commit-and-coalesced.md).

## Context

[ADR-0021](0021-wakeups-after-commit-and-coalesced.md) moved the wake-up notification out of the append, and kept two settings around it:

- **`wakeupMode: "inline"`**, the old behaviour (a `pg_notify` inside every append), "so a deployment that depends on it, or wants to compare, can keep
  it". Nothing depended on it. It was slower (about 3,000 against 5,800 appends a second, measured), and it was a second path inside every append.
- **`listenForWakeups: false`** on each module's configuration, so a module does not `LISTEN` when nothing is sent. "Nothing is sent" was already set on
  the event store (`wakeupMode: "off"`), so one choice had to be made in four places. Set on the event store and forgotten on a module, the module held a
  `LISTEN` connection that never fired; set on a module and not on the event store, that module slept through notifications the others heard. The wallet
  kept them in step by hand (`listenForWakeups: wakeupMode !== "off"`).

## Decision

1. **Two wake-up modes:** `"coalesced"` (the default) and `"off"`. `"inline"` is removed. The unused notify parameters of `append_events_if` stay in the
   SQL (no migration).
2. **The modules follow the event store.** `makeEventStoreLayer` provides a `Wakeups` reference (`"coalesced" | "off"`) next to `EventStore`; each module
   reads it and does not `LISTEN` when it is `"off"`. `listenForWakeups` is removed from `ViewsConfig`, `AutomationsConfig` and `OutboxConfig`. A module
   built without the event store layer sees the reference's default, `"coalesced"`, which is today's default.

## Consequences

- One setting decides whether wake-ups exist: `eventStore.wakeupMode` (`WALLET_WAKEUPS` in the wallet).
- Breaking: `wakeupMode: "inline"` and `listenForWakeups` no longer exist ([ADR-0013](0013-api-evolution-additive-vs-breaking.md)). The wallet refuses
  `WALLET_WAKEUPS=inline` at start-up.
- The throughput diagnostic compares `coalesced` with `off`; the inline figures stay recorded in ADR-0021.

## Alternatives considered

- **Keep `listenForWakeups` and check it against the event store at start-up.** Catches the mismatch, but keeps four settings for one choice.
- **Let the framework count the session connections it holds** (`sessionHolds` is computed by the application today). Considered with this ADR and left
  for later: replacing a number with a counter only improves a warning.
