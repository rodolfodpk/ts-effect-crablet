# @crablet/automations

Automations: when an event appears, issue a **follow-up command**. They run on the same poller as views and the outbox, so they get the same guarantees.

## What it gives you

- **`makeAutomationsProcessor`** (`/AutomationsModule`) - runs the handlers, leader-gated; each decision goes through the `CommandExecutor`.
- **`AutomationHandler`**, **`AutomationDecision`** - a handler says which events wake it, and `decide(event)` returns the decisions; each decision runs the one command the handler is bound to.
- **`AutomationsConfig`**, **`AutomationManagementService`** - configure, inspect and control automations.

Delivery is at-least-once, so the follow-up command must be idempotent (declare `idempotentBy`), otherwise a redelivered event runs it twice.

## Depends on

[`@crablet/commands`](../commands/README.md), [`@crablet/eventstore`](../eventstore/README.md), [`@crablet/event-poller`](../event-poller/README.md), `@crablet/metrics-otel`.

## Read more

[Reference: delivery guarantees](../../docs/reference.md#views-the-outbox-and-automations); the [wallet example](../../examples/wallet-example-app/README.md) has one (`WalletOpenedAutomation`).

Unit tests: `bun test packages/automations/test/*.test.ts`. Integration tests (real Postgres through Testcontainers, needs Docker): `node --test "packages/automations/test/integration/*.test.ts"`.
