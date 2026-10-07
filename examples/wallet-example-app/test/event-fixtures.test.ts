// Every shape the wallet's events have been written in must stay readable, and their tags stable (ADR-0017). To change an event: capture a payload of its CURRENT
// shape into test/fixtures/events (`fixtureOf(storedEvent)`), make the change compatible (a new field gets a default or is optional; anything else is a new
// event type), and this test says whether it is.
import { describe, test } from "bun:test";
import path from "node:path";
import { assertEventFixtures, loadEventFixtures } from "@crablet/commands/testing/EventFixtures";
import * as M from "../src/domain/WalletModel.ts";
import { WelcomeNotificationSent } from "../src/domain/notification/WelcomeNotificationSent.ts";

describe("the wallet's events", () => {
  test("every stored shape still decodes, derives the tags it was stored with, and every event type has a fixture", () => {
    assertEventFixtures({
      definitions: [M.WalletOpened, M.WalletClosed, M.WalletStatementOpened, M.WalletStatementClosed, M.DepositMade, M.WithdrawalMade, M.MoneyTransferred, WelcomeNotificationSent],
      fixtures: loadEventFixtures(path.join(import.meta.dir, "fixtures/events")),
      requireCoverage: true
    });
  });
});
