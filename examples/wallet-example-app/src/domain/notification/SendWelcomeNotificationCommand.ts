import { Effect } from "effect";
import type { CommandHandler } from "@crablet/commands";
import * as CD from "@crablet/commands/CommandDecision";
import * as WalletTags from "../WalletTags.ts";
import { welcomeNotificationSent, WELCOME_NOTIFICATION_SENT } from "./WelcomeNotificationSent.ts";

export interface SendWelcomeNotificationCommand {
  readonly walletId: string;
  readonly owner: string;
}

// Port of com.crablet.examples.wallet.notification.commands.SendWelcomeNotificationCommandHandler.
// Idempotent on (WelcomeNotificationSent, wallet_id), default onDuplicate (RETURN_IDEMPOTENT, not
// THROW) - only one welcome notification ever, per wallet, and safe for a retrying automation to
// silently no-op rather than fail. Only wired into WalletOpenedAutomation's bound CommandHandler -
// deliberately NOT exposed via commands-http (see WalletApp.ts's own note on this).
export const sendWelcomeNotificationCommandHandler: CommandHandler<SendWelcomeNotificationCommand, never> = (
  command
) =>
  Effect.succeed(
    CD.idempotent(
      welcomeNotificationSent({ walletId: command.walletId, owner: command.owner, sentAt: new Date().toISOString() }),
      WELCOME_NOTIFICATION_SENT,
      WalletTags.WALLET_ID,
      command.walletId
    )
  );
