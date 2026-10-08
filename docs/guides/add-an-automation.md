# Add an automation

An automation reacts to an event by issuing a **command**. It runs on the same poller as views, so delivery is at-least-once: the command it issues must be
**idempotent**, or a redelivered event runs it twice. The example is the wallet's welcome notification.

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
  config: defaultAutomationsConfig,
  handlers: [walletOpenedAutomation],
  instanceId
});
yield* automationsHandle.service.start;
```

Only one process runs the automations at a time (the leader of the automations module, one advisory lock for all of them); the others take over if it stops. Reference for the package:
[`@crablet/automations`](../../packages/automations/README.md).
