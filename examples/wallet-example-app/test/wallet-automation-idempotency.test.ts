import { DateTime } from "effect";
import { describe, expect, test } from "bun:test";
import { assertAutomationIdempotent } from "@crablet/automations/testing/AutomationIdempotency";
import { automationScenario } from "@crablet/automations/testing/AutomationScenario";
import { walletOpenedAutomation } from "../src/slices/welcome-notification/WalletOpenedAutomation.ts";
import { WalletOpened } from "../src/shared/WalletModel.ts";

describe("the wallet's automations are idempotent", () => {
  // #region automation-idempotency-test
  test("welcome notification: one per wallet, and a redelivered WalletOpened does it again for none", async () => {
    // triggers that should each produce an effect: two DIFFERENT wallets
    await assertAutomationIdempotent(walletOpenedAutomation, [
      WalletOpened({ walletId: "w1", owner: "Ana", initialBalance: 0, openedAt: DateTime.makeUnsafe("2026-10-09T00:00:00Z") }),
      WalletOpened({ walletId: "w2", owner: "Bo", initialBalance: 0, openedAt: DateTime.makeUnsafe("2026-10-09T00:00:00Z") })
    ]);
  });
  // #endregion automation-idempotency-test
});

describe("what the welcome automation does", () => {
  // #region automation-spec
  test("a wallet opened asks for one welcome to its owner, and the command sends it", async () => {
    const s = automationScenario(walletOpenedAutomation).given();
    const result = await s.when(WalletOpened({ walletId: "w1", owner: "Ana", initialBalance: 0, openedAt: DateTime.makeUnsafe("2026-10-09T00:00:00Z") }));
    expect(result.inputs).toEqual([{ walletId: "w1", owner: "Ana" }]); // what the handler built from the event
    expect(result.events.map((e) => e.type)).toEqual(["WelcomeNotificationSent"]); // what the command appended, caused by the trigger
    expect((await s.redeliver()).events).toEqual([]); // delivered again: nothing more
  });
  // #endregion automation-spec
});
