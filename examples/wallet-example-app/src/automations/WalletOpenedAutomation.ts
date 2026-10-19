import { defineAutomation } from "@crablet/automations/AutomationHandler";
import * as Wallet from "../domain/WalletModel.ts";
import { SendWelcomeNotification } from "../domain/notification/SendWelcomeNotificationCommand.ts";

// The one automation in this app: WalletOpened -> SendWelcomeNotification -> WelcomeNotificationSent
// (idempotent per wallet_id, so a redelivered WalletOpened just re-triggers a no-op notification send,
// not a duplicate). The command is bound directly here, not exposed via commands-http (see
// WalletApp.ts's own note on why).
// #region automation
export const walletOpenedAutomation = defineAutomation("wallet-opened-welcome-notification", SendWelcomeNotification).on(Wallet.WalletOpened, (d) => ({
  walletId: d.walletId,
  owner: d.owner
}));
// #endregion automation
