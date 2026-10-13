# ADR-0030: One polling config, with defaults; no `enabled`

## Status

**Accepted** (2026-10-13). Built: `PollingConfig` and `defaultPollingConfig` in `@crablet/event-poller`; `ViewsConfig`, `AutomationsConfig` and `OutboxConfig` are
`Partial<PollingConfig>`; the `config` argument of `makeViewsProcessor`, `makeAutomationsProcessor` and `makeOutboxProcessor` is optional; `enabled` is removed.
It relates to [ADR-0021](0021-wakeups-after-commit-and-coalesced.md), which gives the 10 s default for `backoffMaxSeconds` its reason.

## Context

The three background modules each had a config type of the same nine fields, all required, so every application wrote them in full, once per module (the wallet
had three identical blocks). The same settings were listed again in four more places:
- `ProcessorConfig`;
- `ProcessorRuntimeOverrides` (the six a single view, automation or publisher can override);
- the three hand-written functions that turned a module's config and a processor's overrides into a `ProcessorConfig`;
- `processorConfigOf`, which carried a second set of defaults (`maxErrors`, the leader retry).

A new setting meant edits in all of them, and the defaults could disagree. `backoffMaxSeconds` already did: the wallet used 10 (the profile the docs recommend) and the
course app 120.

`enabled` was a third way to stop a processor, next to pausing it (a status in the database, changed through the admin API) and starting only some modules in a
process (roles). It was set to `false` in one test, no application read it, and nothing public showed it.

## Decision

1. **`PollingConfig` is the one list of settings, and `defaultPollingConfig` the one set of defaults:** `pollingIntervalMs` 1000, `batchSize` 100, `backoffEnabled`
   true, `backoffThreshold` 3, `backoffMultiplier` 2, `backoffMaxSeconds` 10, `maxErrors` 10, `leaderElectionRetryIntervalMs` 5000. `ProcessorConfig<I>` is
   `PollingConfig` plus the processor's id, and `processorConfigOf` takes its defaults from `defaultPollingConfig`.
2. **A module takes a partial.** `ViewsConfig`, `AutomationsConfig` and `OutboxConfig` are `Partial<PollingConfig>`, and the `config` argument is optional. An
   application names only what it changes. A field that is present but `undefined` does not erase a default.
3. **One function builds a processor's config:** `processorConfigFrom(id, moduleConfig, overrides)` applies the defaults, then the module's config, then the
   processor's own overrides (a `null` or missing override inherits). The three per-module mappers call it.
4. **The overrides are derived.** `ProcessorRuntimeOverrides` is a mapped type over the six overridable keys of `PollingConfig`, so a new overridable setting is
   added in one place. `maxErrors` and the leader retry belong to the module and cannot be overridden by one processor.
5. **`enabled` is removed** from `ProcessorConfig` and the module configs. A processor is stopped at run time by pausing it, and a process runs only some modules
   by role. `EventProcessor` no longer returns early for it.
6. **The leader retry is a module setting, not a processor's.** There is one leader lock per module, so `leaderElectionRetryIntervalMs` is no longer in
   `ProcessorConfig` (it was copied into every processor's config, and `EventProcessor` read it from the first). Each module resolves it from its own config
   (`resolvePollingConfig`) and passes it to the processor once, as `leaderRetryIntervalMs`.
7. **The default `backoffMaxSeconds` is 10,** the "bounded" profile of ADR-0021: an idle processor polls at least every 10 s, so a lost wake-up costs at most that. The
   course app drops its own 120 and uses it.

## Consequences

- An application that wants the defaults passes no `config`; one that wants to change a setting writes one line (`config: { pollingIntervalMs: 200 }`).
- Breaking ([ADR-0013](0013-api-evolution-additive-vs-breaking.md)): a config literal that includes `enabled` no longer compiles (delete the field). A full config
  without it still compiles.
- The course app, and any application that relied on a module config with no `backoffMaxSeconds`, now backs off to 10 s instead of what it wrote, which is the
  documented advice; an application that wants the quiet profile writes `{ backoffMaxSeconds: 120 }`.

## Alternatives considered

- **Keep the configs required and share only a `defaultPollingConfig` to spread.** Removes the typing, but every application still writes `{ ...defaults, ...mine }`
  and the three types stay separate.
- **A single `PollingConfig` for all modules, set once on the layer.** Simpler still, but the modules have different needs (the outbox publishes outside the
  database), so a module-level partial keeps them independent.
- **Keep `enabled`.** It cost a field in four types and a branch in the poller, for a switch nobody used.
