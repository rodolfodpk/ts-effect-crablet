# ADR-0040: A result carries one marker, and a domain file has one import

## Status

**Accepted** (2026-10-20). Built: `ExecutionResult.marker` (`@crablet/commands/ExecutionResult`) and `@crablet/commands/Domain`. Tests:
`repeat.test.ts`, `domain-entry.test.ts`, and the integration tests that wait on a result's marker. Follows [ADR-0038](0038-typed-run-input-and-scoped-processors.md).

## Context

1. **The marker was two nullable fields.** `ExecutionResult` had `lastPosition: bigint | null` and `lastTransactionId: string | null`, null together, while
   a `Marker` type (`@crablet/eventstore/Marker`) already named the pair and `waitUntilProcessed` took one. A caller rebuilt the pair by hand
   (`{ transactionId: result.lastTransactionId!, position: result.lastPosition }`), with a non-null assertion.
2. **A domain file imported from five or six entry points.** One command file read from `/Command`, `/Model`, `/Event`, `/Errors` and
   `@crablet/eventstore/Tag`, so a newcomer learned where each function lives before writing a line.

## Decision

- **`ExecutionResult.marker: Marker | null`** replaces `lastPosition` and `lastTransactionId`; it goes straight to `waitUntilProcessed`, or to a client
  through `formatMarker`. The HTTP response is unchanged: it already carries the two fields and `marker` as strings ([ADR-0011](0011-http-api-from-the-domain-model.md)).
- **`@crablet/commands/Domain` re-exports the declarations**: `defineEvent`, `defineModel`, `all`, `Period`, `defineCommand`, `emit`, `noop`, `fail`,
  `byModel`, `strict`, `concurrent`, `defineContract`, `DomainError`, `personal`, `Tag`, and the types they are written with. The narrow entry points
  stay. A module a browser imports keeps them: `/Domain` reaches the command pipeline.
- **`@crablet/commands` (`"."`) stays the executor.** Wiring and domain are imported in different files.

## Consequences

- **Breaking** for code that read `lastPosition` or `lastTransactionId` from an `ExecutionResult` (pre-release, [ADR-0013](0013-api-evolution-additive-vs-breaking.md)).
  `/Domain` is additive.
- The examples' domain files import from `/Domain`; their contracts and errors keep `/Contract` and `/Errors`.

## Alternatives considered

- **Make `"."` the domain barrel.** Rejected: every `import { CommandExecutor } from "@crablet/commands"` would move, for no gain over a named path.
- **One barrel for the whole framework.** Rejected: it would pull the processors and Postgres into every domain file, and make browser safety harder to see.
