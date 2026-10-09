# Add an automation

An automation reacts to an event by issuing a **command**. It runs on the same poller as views, so delivery is at-least-once: the command it issues must be
**idempotent**, or a redelivered event runs it twice. The framework enforces it: `automationHandlerOf` throws, when the automation is defined, for a command
that declares no `idempotentBy`. The example is the wallet's welcome notification.

[← Task guides](README.md)

## 1. A command that is safe to repeat

`idempotentBy` names the event that means "already done"; a repeat is answered as an idempotent success and appends nothing. This command is not exposed over HTTP,
because only the automation issues it.

<!-- file: examples/wallet-example-app/src/domain/notification/SendWelcomeNotificationCommand.ts#automation-command -->
```ts
export const SendWelcomeNotification = defineCommand({
  name: "SendWelcomeNotificationCommand",
  input,
  idempotentBy: (c) => WelcomeNotificationSent.where({ [WalletTags.WALLET_ID]: c.walletId }),
  decide: (_, c) => emit(WelcomeNotificationSent({ walletId: c.walletId, owner: c.owner, sentAt: new Date().toISOString() }))
});
```

## 2. The handler

It says which events wake it and, for each, returns the decisions to run. Read the event through its definition (`decodeStored`), so an unreadable event is a
typed failure recorded against the automation rather than a wrong action.

<!-- file: examples/wallet-example-app/src/automations/WalletOpenedAutomation.ts#automation -->
```ts
export const walletOpenedAutomation: AutomationHandler<SendWelcomeNotificationCommand, EventDecodingError, never> = automationHandlerOf(
  "wallet-opened-welcome-notification",
  SendWelcomeNotification,
  (event): Effect.Effect<ReadonlyArray<AutomationDecision<SendWelcomeNotificationCommand>>, EventDecodingError, never> =>
    // read through the definition: an unreadable WalletOpened is a typed failure recorded against the automation, not a wrong notification
    Effect.map(Wallet.WalletOpened.decodeStored(event), (data) => [executeCommand({ walletId: data.walletId, owner: data.owner })]),
  { eventTypes: new Set([WalletEvents.WALLET_OPENED]) }
);
```

## 3. Register it

<!-- file: examples/wallet-example-app/src/WalletApp.ts#automations-processor -->
```ts
const automationsHandle = yield* makeAutomationsProcessor({
  config: { ...defaultAutomationsConfig, ...polling },
  handlers: [walletOpenedAutomation],
  instanceId
});
if (roles.has("automations")) yield* automationsHandle.service.start;

```

Only one process runs the automations at a time (the leader of the automations module, one advisory lock for all of them); the others take over if it stops. Reference for the package:
[`@crablet/automations`](../../packages/automations/README.md).

## 4. Test that it is idempotent

`idempotentBy` is yours to write, and a wrong query fails quietly: too narrow and a redelivered event does its work twice, too broad and a legitimate event is
dropped. `assertAutomationIdempotent` runs the automation against an in-memory event store, with no database, and reports both. Give it triggers that should
each produce an effect.

<!-- file: examples/wallet-example-app/test/wallet-automation-idempotency.test.ts#automation-idempotency-test -->
```ts
test("welcome notification: one per wallet, and a redelivered WalletOpened does it again for none", async () => {
  // triggers that should each produce an effect: two DIFFERENT wallets
  await assertAutomationIdempotent(walletOpenedAutomation, [
    WalletOpened({ walletId: "w1", owner: "Ana", initialBalance: 0, openedAt: "2026-10-09T00:00:00Z" }),
    WalletOpened({ walletId: "w2", owner: "Bo", initialBalance: 0, openedAt: "2026-10-09T00:00:00Z" })
  ]);
});
```

It handles the triggers once, then handles them again, and fails with the problems it found:

- **NOT IDEMPOTENT**: the second pass appended events. The command has no `idempotentBy`, or its query never matches what it appends (a misspelled tag, the wrong event type).
- **TOO BROAD**: on the first pass a decision was answered "already done". The query matches something that is not this operation, such as the wallet's id where the deposit's id was needed.
- **FAILED**: a command failed, usually for want of state it reads. Give the events it needs with `{ given: [...] }`.

It is only as good as the triggers: two deposits to the same wallet expose a key on the wallet, two deposits to different wallets do not. It is a test, for you to call;
nothing runs it in production.
