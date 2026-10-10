// The change-impact report for the wallet's decision models (ADR-0017, DCB rule A): when an event type that carries a model's binding tag is added, which models
// have not accounted for it? The slices themselves carry no registry and no boilerplate; the pairs already reviewed are in test/fixtures/model-impact-baseline.json.
// A NEW finding fails this test: handle the event (.on), declare it (.ignores), or accept it into the baseline
// (UPDATE_MODEL_IMPACT_BASELINE=1 bun test test/model-impact.test.ts, then review the diff of the baseline file).
import { describe, test } from "bun:test";
import path from "node:path";
import { loadEventFixtures } from "@crablet/commands/testing/EventFixtures";
import { assertModelImpact, eventFactsFromFixtures, modelFactsOf } from "@crablet/commands/ModelImpact";
import * as M from "../src/domain/WalletModel.ts";
import { WelcomeNotificationSent } from "../src/domain/notification/WelcomeNotificationSent.ts";

describe("the wallet's decision models", () => {
  test("every event type that carries a model's binding tag is accounted for, or already in the baseline", () => {
    assertModelImpact({
      events: eventFactsFromFixtures(
        [M.WalletOpened, M.WalletClosed, M.WalletStatementOpened, M.WalletStatementClosed, M.DepositMade, M.WithdrawalMade, M.MoneyTransferred, WelcomeNotificationSent],
        loadEventFixtures(path.join(import.meta.dir, "fixtures/events"))
      ),
      models: [
        modelFactsOf("WalletModel", M.WalletModel.of({ id: "w", year: 2026, month: 1 })),
        modelFactsOf("WalletLifecycleModel", M.WalletLifecycleModel.of({ id: "w" })),
        modelFactsOf("WalletPeriodModel", M.WalletPeriodModel.of({ id: "w" }))
      ],
      baselineFile: path.join(import.meta.dir, "fixtures/model-impact-baseline.json")
    });
  });
});
