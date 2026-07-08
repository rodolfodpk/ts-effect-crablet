import { Effect } from "effect";
import { automationHandlerOf, type AutomationHandler } from "@crablet/automations/AutomationHandler";
import { executeCommand, type AutomationDecision } from "@crablet/automations/AutomationDecision";
import * as WalletEvents from "../domain/events/WalletEvents.ts";
import { sendWelcomeNotificationCommandHandler, type SendWelcomeNotificationCommand } from "../domain/notification/SendWelcomeNotificationCommand.ts";

// Port of com.crablet.wallet.automations.WalletOpenedAutomation - the one automation in this app.
// WalletOpened -> SendWelcomeNotificationCommand -> WelcomeNotificationSent (idempotent per
// wallet_id, so a redelivered WalletOpened just re-triggers a no-op notification send, not a
// duplicate). The notification command's handler is bound directly here, not exposed via
// commands-http (see WalletApp.ts's own note on why).
export const walletOpenedAutomation: AutomationHandler<
  SendWelcomeNotificationCommand,
  never,
  never
> = automationHandlerOf(
  "wallet-opened-welcome-notification",
  "SendWelcomeNotificationCommand",
  sendWelcomeNotificationCommandHandler,
  (event): Effect.Effect<ReadonlyArray<AutomationDecision<SendWelcomeNotificationCommand>>, never, never> => {
    const data = event.data as WalletEvents.WalletOpened;
    return Effect.succeed([executeCommand<SendWelcomeNotificationCommand>({ walletId: data.walletId, owner: data.owner })]);
  },
  { eventTypes: new Set([WalletEvents.WALLET_OPENED]) }
);
