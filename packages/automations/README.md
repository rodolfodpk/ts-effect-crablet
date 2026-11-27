# @crablet/automations

Automations: when an event appears, issue a **follow-up command**. They run on the same poller as views and the outbox, so they get the same guarantees. Deadlines (run a command once a time has passed) are their own module, [`@crablet/deadlines`](../deadlines/README.md).

## What it gives you

- **`defineAutomation(name, command).on(Event, handler)`** (`/AutomationHandler`) - binds one command, and maps each event it handles to that command's input (one request, several, or `undefined`). The handler is pure; the event types it selects come from `.on`.
- **`module({ automations, overrides, config, describe })`** (the package entry point) - the automations module, which `@crablet/app` runs (`Crablet.modules(...).with(Automations.module(...))`), leader-gated; each request goes through the `CommandExecutor`. `overrides` sets polling and batch per automation, by name.
- **`AutomationsConfig`** - configure the automations. `config` is optional: `AutomationsConfig` is a partial of the shared [polling settings](../../docs/reference/configuration.md#polling-settings).

Delivery is at-least-once, so the follow-up command must recognise a repeat (declare `idempotentBy`). `defineAutomation` refuses a command without it, and `assertAutomationIdempotent` (`@crablet/automations/testing/AutomationIdempotency`) is a test that catches a key too narrow or too broad. `automationScenario` (`/testing/AutomationScenario`) specifies what it does, with no database: given the log, when the triggers are appended, then the inputs it asked for and what its command appended. In production, the database also refuses the same trigger appending the same request twice, whatever the key says ([ADR-0035](../../docs/adr/0035-the-same-trigger-cannot-append-the-same-request-twice.md)), and a key that matches another trigger's different request is refused instead of dropping work ([ADR-0034](../../docs/adr/0034-a-repeat-must-be-the-same-request.md)).

## Depends on

[`@crablet/commands`](../commands/README.md), [`@crablet/eventstore`](../eventstore/README.md), [`@crablet/event-poller`](../event-poller/README.md), `@crablet/metrics-otel`.

## Read more

[Delivery guarantees](../../docs/concepts/views-and-delivery.md); the [wallet example](../../examples/wallet-example-app/README.md) has one (`WalletOpenedAutomation`).

Unit tests: `bun test packages/automations/test/*.test.ts`. Integration tests (real Postgres through Testcontainers, needs Docker): `node --test "packages/automations/test/integration/*.test.ts"`.

## Internal

`./AutomationDecision` (`executeCommand`, `noOp`) is the runtime shape `defineAutomation` builds, `./AutomationsProcessor` (`makeAutomationsProcessor`, `startAutomationsProcessor`) the processor the module builds, and `./AutomationManagementService` what the module hands the admin API through `Processors`; none is an API: it can change without notice ([ADR-0031](../../docs/adr/0031-api-and-plumbing-are-separate.md)).
