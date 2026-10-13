# ADR-0028: The framework decides the wake-up and session settings it can work out itself

## Status

**Accepted** (2026-10-11). Built: `wakeupMode: "inline"` is removed, and the views, automations and outbox modules follow the event store's wake-up
mode through a `Wakeups` reference that `makeEventStoreLayer` provides; `listenForWakeups` is removed. Then, the same day: the framework counts the session
connections a process keeps, and `sessionHolds` is removed (decision 3). Narrows [ADR-0021](0021-wakeups-after-commit-and-coalesced.md) and
[ADR-0024](0024-session-connections-for-leader-and-listen.md).

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
3. **The framework counts the session connections.** `sessionHolds` (on `Crablet.layer`) and `holds` (on `sessionClientsLayer`) are removed. The session
   clients keep a running count: each module adds what it keeps (its leader lock, plus its `LISTEN` when wake-ups are on) the first time it tries for its
   lock, which only happens once it has started; the view-progress hub adds its `LISTEN`. When the total passes the session pool's `maxConnections`, it
   logs the same warning as before, once. The wallet no longer computes it from its roles (`sessionConnectionsHeld` is gone).

## Consequences

- One setting decides whether wake-ups exist: `eventStore.wakeupMode` (`WALLET_WAKEUPS` in the wallet).
- The session pool warning reflects what the process actually started, including wake-ups being off, with nothing to compute or keep in step.
- Breaking: `wakeupMode: "inline"`, `listenForWakeups` and `sessionHolds` no longer exist ([ADR-0013](0013-api-evolution-additive-vs-breaking.md)). The wallet refuses
  `WALLET_WAKEUPS=inline` at start-up.
- The throughput diagnostic compares `coalesced` with `off`; the inline figures stay recorded in ADR-0021.
- Leftovers of the removed notify-from-the-append path: the TypeScript options object that carried the channel and payload is removed, and `append_events_if` still has its two
  defaulted `p_notify_*` parameters (a defaulted pair sits before the last argument, so removing them means rewriting the function, which this does not do). The same cleanup
  dropped two tables nothing ever used, `crablet_module_scan_progress` and `crablet_processor_scan_progress`, with migration V14.

## Alternatives considered

- **Keep `listenForWakeups` and check it against the event store at start-up.** Catches the mismatch, but keeps four settings for one choice.
- **Keep `sessionHolds`.** First left for later (a counter only improves a warning), then done: the number had to be kept in step with the roles and with
  the wake-up mode, which is the same kind of leak as `listenForWakeups`.
