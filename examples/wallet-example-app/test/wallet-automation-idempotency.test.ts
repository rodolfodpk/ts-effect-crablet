import { describe, test } from "bun:test";
import { assertAutomationIdempotent } from "@crablet/automations/testing/AutomationIdempotency";
import { walletOpenedAutomation } from "../src/automations/WalletOpenedAutomation.ts";
import { WalletOpened } from "../src/domain/WalletModel.ts";

describe("the wallet's automations are idempotent", () => {
  // #region automation-idempotency-test
  test("welcome notification: one per wallet, and a redelivered WalletOpened does it again for none", async () => {
    // triggers that should each produce an effect: two DIFFERENT wallets
    await assertAutomationIdempotent(walletOpenedAutomation, [
      WalletOpened({ walletId: "w1", owner: "Ana", initialBalance: 0, openedAt: "2026-10-09T00:00:00Z" }),
      WalletOpened({ walletId: "w2", owner: "Bo", initialBalance: 0, openedAt: "2026-10-09T00:00:00Z" })
    ]);
  });
  // #endregion automation-idempotency-test
});
