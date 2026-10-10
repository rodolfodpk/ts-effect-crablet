// What a second `WalletStatementOpened` for a statement that is already open does to the balance. Commands that raced on a wallet with no statement each opened one (see statement-open-race.test.ts); the
// later opening carries the balance its writer READ, which is older than a deposit that committed in between. The model resets the period's balance to an opening's `openingBalance`, so the deposit disappears.
import { describe, expect, test } from "bun:test";
import { given } from "@crablet/commands/testing/Scenario";
import { Deposit } from "../src/domain/commands/DepositCommand.ts";
import { WalletOpened, WalletStatementOpened } from "../src/domain/WalletModel.ts";

const at = new Date().toISOString();
const dep = (walletId: string, depositId: string, amount: number) => ({ depositId, walletId, amount, description: "" });

describe("a duplicate statement opening", () => {
  // `todo`: this fails today (105, not 115). The framework's period turn (`.period`), which opens a statement only in the append of a command that conflicts if one opened since, keeps such a log from arising (unguarded-opening-balance.test.ts, period-rollover.test.ts); making the model ignore a second
  // opening of the same statement would make this pass and keep a duplicate that did get written (an old log, another writer) from losing money. Run it with `bun test --todo`.
  test.todo("a stale second opening, after a deposit, does not drop that deposit from the balance", async () => {
    const now = new Date();
    const [year, month] = [now.getUTCFullYear(), now.getUTCMonth() + 1];
    const s = given(WalletOpened({ walletId: "w1", owner: "Ann", initialBalance: 100, openedAt: at }));
    const first = await s.when(Deposit, dep("w1", "d1", 10)); // opens the statement (opening 100) and deposits 10
    expect(first.events.map((e) => e.type)).toEqual(["WalletStatementOpened", "DepositMade"]);

    // the racer's opening, written from a balance read before the deposit: same statement, opening balance 100
    const statementId = (first.events[0]!.data as { statementId: string }).statementId;
    s.store.seed(WalletStatementOpened({ walletId: "w1", statementId, year, month, openingBalance: 100, openedAt: at }));

    const next = await s.when(Deposit, dep("w1", "d2", 5));
    const newBalance = (next.events.at(-1)!.data as { newBalance: number }).newBalance;
    // the right balance is 100 + 10 + 5; the model gives 100 + 5 because the second opening reset it
    expect(newBalance).toBe(115);
  });
});
