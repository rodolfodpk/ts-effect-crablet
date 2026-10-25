// The wallet's commands with a statement period of 5 minutes (WALLET_PERIOD=minutes:5), the way the kind lab runs them. The period model is read when the model module is loaded, and `bun test` loads the
// modules once for all the files, so this file runs on its own: `bun run test:unit:period` sets the variable. Without it every test here is skipped.
import { DateTime } from "effect";
import { describe, expect, test } from "bun:test";
import { given } from "@crablet/commands/testing/Scenario";
import { Deposit } from "../src/domain/commands/DepositCommand.ts";
import { TransferMoney } from "../src/domain/commands/TransferMoneyCommand.ts";
import { Withdraw } from "../src/domain/commands/WithdrawCommand.ts";
import { WalletOpened } from "../src/domain/WalletModel.ts";

const on = process.env["WALLET_PERIOD"] === "minutes:5";
const t = on ? test : test.skip;
const at = DateTime.nowUnsafe();
const opened = (walletId: string, initialBalance: number) => WalletOpened({ walletId, owner: "Ann", initialBalance, openedAt: at });
const dep = (walletId: string, depositId: string, amount = 10) => ({ depositId, walletId, amount, description: "" });
const tags = (e: { tags: ReadonlyArray<{ key: string; value: string }> }) => Object.fromEntries(e.tags.map((x) => [x.key, x.value]));
const clock = (minute: number, second = 0) => DateTime.makeUnsafe(Date.UTC(2026, 9, 11, 12, minute, second));

describe("a statement period of 5 minutes", () => {
  t("the first command opens a statement tagged with the year and the slot, and no month", async () => {
    const r = await given(opened("w1", 100)).at(clock(1)).when(Deposit, dep("w1", "d1", 25));
    expect(r.events.map((e) => e.type)).toEqual(["WalletStatementOpened", "DepositMade"]);
    const [statement, deposit] = r.events;
    expect(statement!.data).toMatchObject({ year: 2026, openingBalance: 100 });
    expect(Object.keys(tags(statement!)).sort()).toEqual(["bucket", "statement_id", "wallet_id", "year"]);
    expect(Object.keys(tags(deposit!))).toEqual(expect.arrayContaining(["bucket", "year", "statement_id"]));
    expect(Object.keys(tags(deposit!))).not.toContain("month");
  });

  t("inside one slot nothing turns; the first command of the next slot closes it and opens the next, carrying the balance", async () => {
    const s = given(opened("w1", 100));
    await s.at(clock(1)).when(Deposit, dep("w1", "d1", 25));
    const same = await s.at(clock(4, 59)).when(Deposit, dep("w1", "d2", 5));
    expect(same.events.map((e) => e.type)).toEqual(["DepositMade"]);
    const turned = await s.at(clock(5)).when(Deposit, dep("w1", "d3", 7));
    expect(turned.events.map((e) => e.type)).toEqual(["WalletStatementClosed", "WalletStatementOpened", "DepositMade"]);
    const [closed, reopened, deposit] = turned.events;
    expect(closed!.data).toMatchObject({ closingBalance: 130 });
    expect(reopened!.data).toMatchObject({ openingBalance: 130 });
    expect(deposit!.data).toMatchObject({ newBalance: 137 });
    expect(tags(closed!)["statement_id"]).not.toBe(tags(reopened!)["statement_id"]);
    expect(tags(reopened!)["bucket"]).toBe(String(Number(tags(closed!)["bucket"]) + 1));
  });

  t("a withdrawal decides on the balance carried into the new slot", async () => {
    const s = given(opened("w1", 100));
    await s.at(clock(1)).when(Deposit, dep("w1", "d1", 20));
    const r = await s.at(clock(6)).when(Withdraw, { withdrawalId: "x1", walletId: "w1", amount: 50, description: "" });
    expect(r.events.map((e) => e.type)).toEqual(["WalletStatementClosed", "WalletStatementOpened", "WithdrawalMade"]);
    expect(r.events[0]!.data).toMatchObject({ closingBalance: 120 });
    expect(r.events.at(-1)!.data).toMatchObject({ newBalance: 70 });
  });

  t("a transfer turns both wallets and is tagged with the year and the slot, never a month", async () => {
    const s = given(opened("a", 100), opened("b", 0));
    await s.at(clock(1)).when(Deposit, dep("a", "d1", 0.5));
    await s.at(clock(1)).when(Deposit, dep("b", "d2", 0.5));
    const r = await s.at(clock(5, 30)).when(TransferMoney, { transferId: "t1", fromWalletId: "a", toWalletId: "b", amount: 40, description: "" });
    expect(r.events.filter((e) => e.type === "WalletStatementClosed")).toHaveLength(2);
    expect(r.events.filter((e) => e.type === "WalletStatementOpened")).toHaveLength(2);
    const transfer = r.events.find((e) => e.type === "MoneyTransferred")!;
    expect(Object.keys(tags(transfer))).toEqual(expect.arrayContaining(["bucket", "year", "from_statement_id", "to_statement_id"]));
    expect(Object.keys(tags(transfer))).not.toContain("month");
  });

  t("a pod whose clock is still in the old slot never turns the period back", async () => {
    const s = given(opened("w1", 0));
    await s.at(clock(5)).when(Deposit, dep("w1", "d1", 5));
    const r = await s.at(clock(4, 59)).when(Deposit, dep("w1", "d2", 7));
    expect(r.events.map((e) => e.type)).toEqual(["DepositMade"]);
    expect(tags(r.events[0]!)["bucket"]).toBe(String(Math.floor(DateTime.toEpochMillis(clock(5)) / 300_000)));
  });
});
