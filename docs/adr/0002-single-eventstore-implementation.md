# ADR-0002: Single EventStore implementation via Effect's ambient transaction context

## Status

Accepted (Phase 1)

## Context

Java's `EventStoreImpl` needs two parallel implementations of every append/project method: one
using a fresh pooled connection (`appendIf`), and one using an already-open transaction-scoped
connection (`appendIfWithConnection`, wrapped by an inner `ConnectionScopedEventStore` class) —
because Java has no ambient way to know "am I inside a transaction right now?" without explicit
plumbing threaded through every call site.

Effect's `SqlClient.withTransaction` makes this ambient: whatever `SqlClient` is present in the
current Effect context is already transaction-scoped inside a `withTransaction` block, and
un-scoped outside it. Callers don't need to know or pass along which mode they're in.

## Decision

Ship one `EventStore` implementation that handles both the pooled and transaction-scoped cases —
no dual-class design. The same reasoning extends to `CommandHandler`: Java's
`handle(EventStore eventStore, T command)` takes the store explicitly because there's no ambient
context; the TS `CommandHandler<T> = (command: T) => Effect<CommandDecision, E, EventStore>` gets
`EventStore` from Effect's context automatically (`yield* EventStore` inside the handler), so the
signature only needs the command.

## Consequences

- Less code to maintain than the Java port would suggest — no `ConnectionScopedEventStore`
  equivalent exists or is needed in this codebase.
- Handler and store code must not accidentally call `Effect.provide` with a fresh `SqlClient`
  layer inside a `withTransaction` block, or the ambient transaction scoping breaks silently.
- This pattern only works because Effect's context propagation is fiber-local; it depends on
  callers actually running inside the same Effect program tree, not spawning detached work that
  loses the ambient `SqlClient`.
