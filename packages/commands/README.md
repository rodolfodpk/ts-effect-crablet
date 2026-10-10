# @crablet/commands

The authoring API. You declare **events**, **models** and **commands**; the executor turns a command into one atomic, conditional append and retries it on a conflict.
This is the package most application code imports.

## What it gives you

- **`defineEvent`** (`/Event`) - a name, a payload Schema and the tags the event is found by.
- **`defineModel`** and **`all(...)`** (`/Model`) - what events mean for an entity, and (from the same declaration) the boundary a command is consistent with.
- **`.period(Period.month, ...)`** (`/Period`) - a model that closes one statement, shift or page and opens the next with the state carried forward: declared once on the model, turned by the framework in the command's own append ([ADR-0025](../../docs/adr/0025-the-framework-turns-the-period.md)).
- **`defineCommand`** (`/Command`) - a pure `decide` over model state: `emit`, `fail`, or `noop`. **`commandContract`** (`/Contract`) is its public half (name, input, errors).
- **`DomainError`** (`/Errors`), **`Personal`** (marking personal data) and **`CommandAudit`**.
- **`Crablet.layer`** (`/Crablet`) - Postgres connection in, working `CommandExecutor` and event store out.
- **Testing without a database** - `given(...).when(Command, input)` (`/testing/Scenario`) on the in-memory store, and `EventFixtures` for stored-event fixtures.
- **Event evolution checks** - `VerifyEvents` (decode stored events with the current definitions) and `ModelImpact` (the change-impact report).

## Depends on

[`@crablet/eventstore`](../eventstore/README.md), `@crablet/metrics-otel`, `effect`, `@effect/sql-pg`.

## Read more

The [README example](../../README.md), the [tutorial](../../docs/tutorial/README.md), the [DCB guide](../../docs/dcb-guide.md),
[Evolving events](../../docs/evolving-events.md), [ADR-0010](../../docs/adr/0010-declarative-command-api.md), [ADR-0017](../../docs/adr/0017-event-evolution-by-compatibility.md).

Unit tests: `bun test packages/commands/test/*.test.ts`. Integration tests (real Postgres through Testcontainers, needs Docker): `node --test "packages/commands/test/integration/*.test.ts"`. Diagnostics (outside CI): `packages/commands/diagnostics/`.
