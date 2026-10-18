# Add an automation

*Guide · developers · the [tutorial](../../tutorial/README.md) · 10 minutes*

An automation reacts to an event by issuing a **command**. It runs on the same poller as views, so delivery is at-least-once: the command it issues must be
**idempotent**, or a redelivered event runs it twice. The framework enforces it: `defineAutomation` throws, when the automation is defined, for a command
that declares no `idempotentBy`. The example is the wallet's welcome notification.

[← Task guides](../README.md)

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

`defineAutomation(name, command)` binds the command, and `.on(Event, handler)` says which event wakes it: the handler maps the event's data to the command's
input, one request, an array of them, or `undefined` for none. The event is read through its own definition, so an unreadable one is a typed failure
recorded against the automation rather than a wrong action. The handler is pure: if deciding needs state, the command reads it (`model`, `resolve`), where
it is consistent. Building the input from the trigger also makes a redelivery the same request.

<!-- file: examples/wallet-example-app/src/automations/WalletOpenedAutomation.ts#automation -->
```ts
export const walletOpenedAutomation = defineAutomation("wallet-opened-welcome-notification", SendWelcomeNotification).on(Wallet.WalletOpened, (d) => ({
  walletId: d.walletId,
  owner: d.owner
}));
```

The name keys the automation's progress (its cursor): keep it when you change the automation, or it starts again from the beginning of the log.

## 3. Register it

<!-- file: examples/wallet-example-app/src/WalletApp.ts#automations-processor -->
```ts
const automationsHandle = yield* makeAutomationsProcessor({
  config: polling,
  automations: [walletOpenedAutomation],
  instanceId
});
if (roles.has("automations")) yield* automationsHandle.service.start;

```

Polling and batch settings for one automation go to the processor by name, `overrides: { "wallet-opened-welcome-notification": { batchSize: 10 } }`, not
into its definition. Only one process runs the automations at a time (the leader of the automations module, one advisory lock for all of them); the others take over if it stops. Reference for the package:
[`@crablet/automations`](../../../packages/automations/README.md).

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

- **NOT IDEMPOTENT**: on the second pass the key did not recognise the repeat: the command has no `idempotentBy`, or its query never matches what it appends
  (a misspelled tag, the wrong event type). The framework's backstop still stops the same trigger from appending the same request twice (below), so this shows
  as repeats the backstop caught, not as events appended twice.
- **TOO BROAD**: on the first pass a decision was answered "already done", or was refused because the key was already used by a different request
  (`IdempotencyMismatch`). The query matches something that is not this operation, such as the wallet's id where the deposit's id was needed.
- **FAILED**: a command failed, usually for want of state it reads. Give the events it needs with `{ given: [...] }`.

It is only as good as the triggers: two deposits to the same wallet expose a key on the wallet, two deposits to different wallets do not. It is a test, for you to call;
nothing runs it in production.

## What protects it in production

Two things, so a wrong key costs a warning, not wrong data ([ADR-0034](../../adr/0034-a-repeat-must-be-the-same-request.md),
[ADR-0035](../../adr/0035-the-same-trigger-cannot-append-the-same-request-twice.md)):

- **The same trigger cannot append the same request twice.** An append made by an automation carries the trigger's position and a key built from the
  request's content, unique in the database. A redelivered trigger whose `idempotentBy` never matches is still "already done", with the reason
  `ALREADY_DONE_FOR_TRIGGER`, and a warning names the command. It is keyed by content, so a redelivery whose `decide` returns more decisions still appends
  what is new. Build the command's input from the trigger, so a redelivery builds the same request.
- **A key used by another trigger's different request is refused** (`IdempotencyMismatch`), not answered "already done": a key that is too broad stops the
  automation, loudly, instead of dropping work in silence.
