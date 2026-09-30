# ADR-0010: A declarative command API (events, models, commands) over the append primitive

## Status

Accepted (API redesign, Phases 1-6)

## Context

The first version of this framework had a low-level shape inherited from the framework it was ported
from: a command handler was an `Effect` that read state, then returned one of five decision variants
(`Commutative`, `CommutativeGuarded`, `NonCommutative`, `Idempotent`, `NoOp`), each appended through its
own `EventStore` method. Writing a handler meant, every time: resolve a period, project state (three
separate projections for a transfer), check existence, hand-build `Tag`s, pick the right variant and
repeat event-type and tag-key strings for idempotency. A deposit handler was ~40 lines and a transfer
~70. Decision logic could not be tested without Postgres, error types were written out by hand, and the
five variants were only presets of two independent checks the SQL append already had (a concurrency
check and an idempotency check) - which is why "strict AND idempotent" was impossible to express, and
why the withdraw handler hand-rolled a racy `exists()` pre-check instead.

The redesign also stops treating the predecessor framework this repo started from as a constraint: this is
its own product, free to rename and reshape any low-level component.

## Decision

Keep ONE write primitive and build a declarative layer on top of it.

- **`EventStore.append(events, condition?)`** replaces four append methods. A condition is a concurrency
  check (was anything in this query appended after this log position?) plus an idempotency check (does
  anything matching this query already exist?), independent of each other. Refusals are two typed errors:
  `Conflict { kind: "boundary" | "guard" }` and `Duplicate`.
- **`defineEvent`** owns an event's name, payload schema, tag derivation and typed queries (an unknown tag
  key is a compile error).
- **`defineModel`** (a chained builder) gives, from one declaration, both the state fold and the
  consistency-boundary query, so they cannot drift. Lifecycle events are unscoped; a two-party event can
  be bound through either of two tags; `all({...})` is one boundary over several entities.
- **`defineCommand`** has a PURE `decide`. The framework runs, in one transaction: idempotency pre-check ->
  `prepare` -> load -> decide -> conditional append. Consistency is `strict()` (default) or
  `concurrent({ guard? })`; idempotency is `idempotentBy` (+ `onDuplicate`); the two are independent, so
  every combination works.
- **Conflict retry** lives in `CommandExecutor.run`: a `Conflict` re-runs the whole command (fresh
  transaction, fresh load, pure `decide` again) up to `retries` times. The loser of a race therefore
  usually ends with the domain answer, not a `Conflict`.
- **Typed errors, inferred.** A command's error type is the union of its `fail(...)`s plus `prepare`'s.
  Domain errors are declared with `DomainError(tag, { fields, kind })`; `kind` is a neutral category, NOT an
  HTTP status. The REST layer maps kinds to statuses and refuses, at compile time, to expose a command
  whose errors it cannot present.
- **Testability is part of the design:** `spec/Spec.ts` (what reads and appends mean, as pure functions),
  an in-memory store that enforces it, a conformance suite and a differential test proving it agrees with
  Postgres, and `given(events).when(command, input)` for BDD-style tests with no database.
- The old hand-written handlers are gone: `CommandExecutor.execute` and the `CD.*` builders
  (`commutativeIdempotent`, `idempotent`, ...) were deleted, and `CommandDecision` is now an internal
  detail of `defineCommand`. `run`/`runDecoded` are the only ways to run a command.

## Consequences

- A command is typically 10-15 lines (deposit 40 -> 14, withdraw 55 -> 15, the five wallet commands
  196 -> 90). The one command that stays long is a two-wallet transfer (69 -> 41): two periods to prepare,
  a combined model, and a long chain of refusals.
- **Idempotency is checked before `prepare` and `decide`, from the input alone.** `idempotentBy` must
  depend only on the command's input. This is what makes retries safe when the first attempt already
  changed the state `decide` reads.
- **`decide` is pure but stamps time itself** (`new Date()`); tests that need a fixed time must not assert
  on timestamps.
- **A `concurrent()` command's model must fold order-insensitively** (sum amounts, do not trust snapshots
  a writer computed from the state it saw), or concurrent commands lose updates. The wallet's old fold did
  exactly that; it now sums.
- Strict consistency on a model-less command is a runtime defect, not yet a type error.
- Verifying the in-memory store against Postgres cost real effort but paid for itself immediately: the
  conformance suite found that tag values containing commas were being stored as different tags.

## Alternatives considered

- **Stream/aggregate-per-entity (Emmett-style).** Rejected: it would abandon the reason this framework
  exists. A stream per aggregate forces either a saga or one giant stream for a multi-entity invariant
  such as a transfer; DCB makes it one atomic command.
- **An array of handlers** (`defineModel({ on: [on(E, ...), ...] })`). Rejected: TypeScript cannot drive a
  nested generic call's state type from the enclosing call's in-progress inference, so every handler's
  state collapsed to `unknown`. The chained builder fixes the state type first.
- **HTTP status carried by the domain error.** Rejected: it couples the domain to a transport. A neutral
  `kind` lets each transport decide.
- **A single shared Postgres for tests.** Rejected during the work: the poller's visibility rule is
  cluster-wide, so open transactions in other databases hid events from unrelated tests.
