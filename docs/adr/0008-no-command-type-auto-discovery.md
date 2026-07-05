# ADR-0008: No command-type auto-discovery — handlers passed explicitly at every call site

## Status

Accepted (Phase 1)

## Context

Java's `CommandExecutor.execute(command)` (single-arg) reflects on a JSON `commandType` property
to find the registered handler at runtime. TypeScript has no equivalent runtime reflection without
extra machinery (e.g. a `Map` keyed by some discriminant, populated via a registration step).

## Decision

Every call site in this port passes the handler explicitly: `execute(command, handler)`. No
command-type registry or auto-discovery mechanism is built.

## Consequences

- Callers always have the handler in hand at the call site, which is slightly more verbose than
  Java's single-arg form but requires no registration/discovery machinery and has no reflection
  cost or runtime lookup failure mode.
- A `Layer`-composed handler registry remains a reasonable future addition if ergonomics demand it
  (e.g. once a REST-style command endpoint needs to dispatch on a wire-level `commandType` string
  without the caller already knowing which handler to use) — deliberately deferred, not ruled out.
