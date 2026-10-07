import { Effect } from "effect";
import { automationHandlerOf, type AutomationHandler } from "@crablet/automations/AutomationHandler";
import { executeCommand, type AutomationDecision } from "@crablet/automations/AutomationDecision";
import type { EventDecodingError } from "@crablet/eventstore/EventDecoding";
import * as Wallet from "../domain/WalletModel.ts";
import * as WalletEvents from "../domain/events/WalletEvents.ts";
import {
  SendWelcomeNotification,
  type SendWelcomeNotificationCommand
} from "../domain/notification/SendWelcomeNotificationCommand.ts";

// The one automation in this app: WalletOpened -> SendWelcomeNotification -> WelcomeNotificationSent
// (idempotent per wallet_id, so a redelivered WalletOpened just re-triggers a no-op notification send,
// not a duplicate). The command is bound directly here, not exposed via commands-http (see
// WalletApp.ts's own note on why).
export const walletOpenedAutomation: AutomationHandler<SendWelcomeNotificationCommand, EventDecodingError, never> = automationHandlerOf(
  "wallet-opened-welcome-notification",
  SendWelcomeNotification,
  (event): Effect.Effect<ReadonlyArray<AutomationDecision<SendWelcomeNotificationCommand>>, EventDecodingError, never> =>
    // read through the definition: an unreadable WalletOpened is a typed failure recorded against the automation, not a wrong notification
    Effect.map(Wallet.WalletOpened.decodeStored(event), (data) => [executeCommand({ walletId: data.walletId, owner: data.owner })]),
  { eventTypes: new Set([WalletEvents.WALLET_OPENED]) }
);
