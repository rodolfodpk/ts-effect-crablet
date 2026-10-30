# @crablet/automations

Automations: when an event appears, issue a **follow-up command**; and deadlines: when a time has passed, run a command. They run on the same poller as views and the outbox, so they get the same guarantees.

## What it gives you

- **`defineAutomation(name, command).on(Event, handler)`** (`/AutomationHandler`) - binds one command, and maps each event it handles to that command's input (one request, several, or `undefined`). The handler is pure; the event types it selects come from `.on`.
- **`startAutomationsProcessor({ automations, overrides })`** (`/AutomationsModule`) - runs the automations, leader-gated, owned by the Scope (`makeAutomationsProcessor` builds without starting); each request goes through the `CommandExecutor`. `overrides` sets polling and batch per automation, by name.
- **`startDeadlinesProcessor({ commands, config })`** (`/Deadlines`) - fires the deadlines commands set with `deadline(...)`, leader-gated (`makeDeadlinesProcessor` builds without starting); `config` is a `DeadlinesConfig`, the polling settings plus `fireTimeoutMs`, how long one firing may take ([set a deadline](../../docs/guides/build/set-a-deadline.md), [ADR-0043](../../docs/adr/0043-a-deadline-is-an-event-in-the-log.md)).
- **`makeDeadlinesManagementService`** (`/DeadlinesManagementService`) - inspect and control the deadlines processor, with its backlog: the deadlines due and not fired.
- **`AutomationsConfig`**, **`AutomationManagementService`** - configure, inspect and control automations. `config` is optional: `AutomationsConfig` is a partial of the shared [polling settings](../../docs/reference/configuration.md#polling-settings).

Delivery is at-least-once, so the follow-up command must recognise a repeat (declare `idempotentBy`). `defineAutomation` refuses a command without it, and `assertAutomationIdempotent` (`@crablet/automations/testing/AutomationIdempotency`) is a test that catches a key too narrow or too broad. In production, the database also refuses the same trigger appending the same request twice, whatever the key says ([ADR-0035](../../docs/adr/0035-the-same-trigger-cannot-append-the-same-request-twice.md)), and a key that matches another trigger's different request is refused instead of dropping work ([ADR-0034](../../docs/adr/0034-a-repeat-must-be-the-same-request.md)).

## Depends on

[`@crablet/commands`](../commands/README.md), [`@crablet/eventstore`](../eventstore/README.md), [`@crablet/event-poller`](../event-poller/README.md), `@crablet/metrics-otel`.

## Read more

[Delivery guarantees](../../docs/concepts/views-and-delivery.md); the [wallet example](../../examples/wallet-example-app/README.md) has one (`WalletOpenedAutomation`).

Unit tests: `bun test packages/automations/test/*.test.ts`. Integration tests (real Postgres through Testcontainers, needs Docker): `node --test "packages/automations/test/integration/*.test.ts"`.

## Internal

`./AutomationDecision` (`executeCommand`, `noOp`) is the runtime shape `defineAutomation` builds, not an API: it can change without notice ([ADR-0031](../../docs/adr/0031-api-and-plumbing-are-separate.md)).
