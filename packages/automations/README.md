# @crablet/automations

Automations: when an event appears, issue a **follow-up command**. They run on the same poller as views and the outbox, so they get the same guarantees.

## What it gives you

- **`makeAutomationsProcessor`** (`/AutomationsModule`) - runs the handlers, leader-gated; each decision goes through the `CommandExecutor`.
- **`AutomationHandler`**, **`AutomationDecision`** - a handler says which events wake it, and `decide(event)` returns the decisions; each decision runs the one command the handler is bound to.
- **`AutomationsConfig`**, **`AutomationManagementService`** - configure, inspect and control automations. `config` is optional: `AutomationsConfig` is a partial of the shared [polling settings](../../docs/reference/configuration.md#polling-settings).

Delivery is at-least-once, so the follow-up command must recognise a repeat (declare `idempotentBy`). `automationHandlerOf` refuses a command without it, and `assertAutomationIdempotent` (`@crablet/automations/testing/AutomationIdempotency`) is a test that catches a key too narrow or too broad. In production, the database also refuses the same trigger appending the same request twice, whatever the key says ([ADR-0035](../../docs/adr/0035-the-same-trigger-cannot-append-the-same-request-twice.md)), and a key that matches another trigger's different request is refused instead of dropping work ([ADR-0034](../../docs/adr/0034-a-repeat-must-be-the-same-request.md)).

## Depends on

[`@crablet/commands`](../commands/README.md), [`@crablet/eventstore`](../eventstore/README.md), [`@crablet/event-poller`](../event-poller/README.md), `@crablet/metrics-otel`.

## Read more

[Delivery guarantees](../../docs/concepts/views-and-delivery.md); the [wallet example](../../examples/wallet-example-app/README.md) has one (`WalletOpenedAutomation`).

Unit tests: `bun test packages/automations/test/*.test.ts`. Integration tests (real Postgres through Testcontainers, needs Docker): `node --test "packages/automations/test/integration/*.test.ts"`.
