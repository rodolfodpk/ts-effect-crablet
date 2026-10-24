// The wallet's commands, tested BDD-style with NO database: given a history, when a command arrives,
// then what happened. Runs the real pipeline (validation, idempotency check, the statement period,
// model load, decide, conditional append) against the in-memory event store.
import { DateTime } from "effect";
import { describe, expect, test } from "bun:test";
import type { AppendEvent } from "@crablet/eventstore/AppendEvent";
import { InvalidInput } from "@crablet/commands/Errors";
import { assertRepeatHarmless, given } from "@crablet/commands/testing/Scenario";
import { CloseWallet } from "../src/domain/commands/CloseWalletCommand.ts";
import { Deposit } from "../src/domain/commands/DepositCommand.ts";
import { OpenWallet } from "../src/domain/commands/OpenWalletCommand.ts";
import { TransferMoney } from "../src/domain/commands/TransferMoneyCommand.ts";
import { Withdraw } from "../src/domain/commands/WithdrawCommand.ts";
import { InsufficientFunds, WalletAlreadyExists, WalletNotFound } from "../src/domain/errors/WalletErrors.ts";
import { WalletClosed, WalletOpened } from "../src/domain/WalletModel.ts";

const at = DateTime.nowUnsafe();
const opened = (walletId: string, initialBalance: number) => WalletOpened({ walletId, owner: "Ann", initialBalance, openedAt: at });
const dep = (walletId: string, depositId: string, amount = 10) => ({ depositId, walletId, amount, description: "" });
const wd = (walletId: string, withdrawalId: string, amount: number) => ({ withdrawalId, walletId, amount, description: "" });
const tags = (e: { tags: ReadonlyArray<{ key: string; value: string }> }) => Object.fromEntries(e.tags.map((t) => [t.key, t.value]));

describe("OpenWallet", () => {
  test("appends WalletOpened", async () => {
    const r = await given().when(OpenWallet, { walletId: "w1", owner: "Ann", initialBalance: 50 });
    expect(r.outcome).toBe("created");
    expect(r.events.map((e) => e.type)).toEqual(["WalletOpened"]);
    expect(r.events[0]!.data).toMatchObject({ walletId: "w1", owner: "Ann", initialBalance: 50 });
  });

  test("the same open again is a retry: already opened, nothing appended", async () => {
    const r = await given(opened("w1", 50)).when(OpenWallet, { walletId: "w1", owner: "Ann", initialBalance: 50 });
    expect(r.outcome).toBe("idempotent");
    expect(r.reason).toBe("ALREADY_OPENED");
    expect(r.events).toEqual([]);
  });

  test("a different wallet under an id that is taken is refused with WalletAlreadyExists", async () => {
    for (const other of [{ owner: "Bob", initialBalance: 50 }, { owner: "Ann", initialBalance: 0 }]) {
      const r = await given(opened("w1", 50)).when(OpenWallet, { walletId: "w1", ...other });
      expect(r.error).toBeInstanceOf(WalletAlreadyExists);
      expect(r.events).toEqual([]);
    }
  });

  test("a closed wallet's id is not reused", async () => {
    const r = await given(opened("w1", 50), WalletClosed({ walletId: "w1", closedAt: at })).when(OpenWallet, { walletId: "w1", owner: "Bob", initialBalance: 0 });
    expect(r.error).toBeInstanceOf(WalletAlreadyExists);
  });

  test("blank names and a negative initial balance are invalid input", async () => {
    for (const bad of [{ walletId: " ", owner: "Ann", initialBalance: 0 }, { walletId: "w", owner: "", initialBalance: 0 }, { walletId: "w", owner: "Ann", initialBalance: -1 }]) {
      expect((await given().when(OpenWallet, bad)).error).toBeInstanceOf(InvalidInput);
    }
  });
});

describe("Deposit", () => {
  // #region scenarios
  test("lazily opens this month's statement, then records the deposit on it", async () => {
    const r = await given(opened("w1", 100)).when(Deposit, dep("w1", "d1", 25));
    expect(r.outcome).toBe("created");
    expect(r.events.map((e) => e.type)).toEqual(["WalletStatementOpened", "DepositMade"]);
    const [statement, deposit] = r.events;
    expect(statement!.data).toMatchObject({ openingBalance: 100 });
    expect(deposit!.data).toMatchObject({ amount: 25, newBalance: 125 });
    expect(tags(deposit!)).toMatchObject({ wallet_id: "w1", deposit_id: "d1", statement_id: tags(statement!)["statement_id"] });
  });

  test("a second deposit in the same month reuses the open statement", async () => {
    const s = given(opened("w1", 0));
    await s.when(Deposit, dep("w1", "d1"));
    const r = await s.when(Deposit, dep("w1", "d2", 5));
    expect(r.events.map((e) => e.type)).toEqual(["DepositMade"]);
    expect(r.events[0]!.data).toMatchObject({ newBalance: 15 });
  });

  test("an unknown wallet is WalletNotFound - and the statement it would have opened is not written", async () => {
    const s = given();
    const r = await s.when(Deposit, dep("ghost", "d1"));
    expect(r.error).toBeInstanceOf(WalletNotFound);
    expect(s.log).toEqual([]);
  });

  test("a repeated deposit id is an idempotent success and appends nothing", async () => {
    const s = given(opened("w1", 0));
    await s.when(Deposit, dep("w1", "d1"));
    const repeat = await s.when(Deposit, dep("w1", "d1"));
    expect(repeat.outcome).toBe("idempotent");
    expect(repeat.events).toEqual([]);
  });
  // #endregion scenarios

  // #region period-scenarios
  test("the first deposit of the next month closes this month's statement and opens the next, carrying the balance", async () => {
    const s = given(opened("w1", 100));
    await s.at(new Date(Date.UTC(2026, 9, 31, 23, 59))).when(Deposit, dep("w1", "d1", 25));
    const r = await s.at(new Date(Date.UTC(2026, 10, 1, 0, 1))).when(Deposit, dep("w1", "d2", 5));
    expect(r.events.map((e) => e.type)).toEqual(["WalletStatementClosed", "WalletStatementOpened", "DepositMade"]);
    const [closed, opened2, deposit] = r.events;
    expect(closed!.data).toMatchObject({ month: 10, openingBalance: 100, closingBalance: 125 }); // the October statement opened with 100
    expect(opened2!.data).toMatchObject({ month: 11, openingBalance: 125 });
    expect(deposit!.data).toMatchObject({ newBalance: 130 });
  });

  test("a pod whose clock is still in October never turns the month back", async () => {
    const s = given(opened("w1", 0));
    await s.at(new Date(Date.UTC(2026, 10, 1, 0, 1))).when(Deposit, dep("w1", "d1", 5));
    const r = await s.at(new Date(Date.UTC(2026, 9, 31, 23, 59))).when(Deposit, dep("w1", "d2", 7));
    expect(r.events.map((e) => e.type)).toEqual(["DepositMade"]);
    expect(tags(r.events[0]!)).toMatchObject({ month: "11" });
  });
  // #endregion period-scenarios

  test("a deposit must be positive", async () => {
    expect((await given(opened("w1", 0)).when(Deposit, dep("w1", "d1", 0))).error).toBeInstanceOf(InvalidInput);
  });
});

describe("Withdraw", () => {
  test("reduces the balance", async () => {
    const r = await given(opened("w1", 100)).when(Withdraw, wd("w1", "x1", 30));
    expect(r.events.at(-1)!.data).toMatchObject({ amount: 30, newBalance: 70 });
  });

  test("more than the balance fails with InsufficientFunds, carrying the figures", async () => {
    const r = await given(opened("w1", 30)).when(Withdraw, wd("w1", "x1", 100));
    expect(r.error).toBeInstanceOf(InsufficientFunds);
    expect(r.error).toMatchObject({ walletId: "w1", currentBalance: 30, requestedAmount: 100 });
  });

  test("retrying a withdrawal is 'already done' even though the balance no longer covers it", async () => {
    const s = given(opened("w1", 30));
    expect((await s.when(Withdraw, wd("w1", "x1", 30))).outcome).toBe("created"); // balance is now 0
    const retry = await s.when(Withdraw, wd("w1", "x1", 30)); // deciding again would say "insufficient funds"
    expect(retry.outcome).toBe("idempotent");
    // while a NEW withdrawal of the same amount is refused
    expect((await s.when(Withdraw, wd("w1", "x2", 30))).error).toBeInstanceOf(InsufficientFunds);
  });
});

// Two deposits decided at the same moment from a balance of 100 are both accepted (deposits are concurrent), and the second records a STALE newBalance: 120, not 130, because it never saw the first.
// The history is built from the real deposit events, with the second one's newBalance replaced by what a concurrent writer would have recorded.
const withStaleDeposit = async () => {
  const s = given(opened("w1", 100));
  const first = await s.when(Deposit, dep("w1", "dA", 10)); // newBalance 110
  const second = await s.when(Deposit, dep("w1", "dB", 20)); // newBalance 130 when run after the first
  const asAppended = (events: typeof first.events, newBalance?: number): ReadonlyArray<AppendEvent> =>
    events.map((e) => ({ type: e.type, tags: e.tags, eventData: newBalance === undefined ? e.data : { ...(e.data as object), newBalance } }));
  expect(first.events.at(-1)!.data).toMatchObject({ newBalance: 110 });
  expect(second.events.at(-1)!.data).toMatchObject({ amount: 20, newBalance: 130 });
  return given(opened("w1", 100), ...asAppended(first.events), ...asAppended(second.events, 120));
};

describe("a withdrawal after concurrent deposits that recorded a stale newBalance", () => {
  test("decides on the sum of the amounts (130), not on the stale 120: a withdrawal of 125 succeeds", async () => {
    const r = await (await withStaleDeposit()).when(Withdraw, wd("w1", "x1", 125));
    expect(r.outcome).toBe("created");
    expect(r.events.at(-1)!.data).toMatchObject({ amount: 125, newBalance: 5 });
  });

  test("and one of 135 is refused with the true balance, 130", async () => {
    const r = await (await withStaleDeposit()).when(Withdraw, wd("w1", "x1", 135));
    expect(r.error).toBeInstanceOf(InsufficientFunds);
    expect(r.error).toMatchObject({ walletId: "w1", currentBalance: 130, requestedAmount: 135 });
  });
});

describe("TransferMoney", () => {
  test("moves the money, tagging both wallets and both statements", async () => {
    const r = await given(opened("a", 100), opened("b", 0)).when(TransferMoney, { transferId: "t1", fromWalletId: "a", toWalletId: "b", amount: 40, description: "" });
    expect(r.outcome).toBe("created");
    const transfer = r.events.find((e) => e.type === "MoneyTransferred")!;
    expect(transfer.data).toMatchObject({ fromBalance: 60, toBalance: 40 });
    expect(Object.keys(tags(transfer))).toEqual(expect.arrayContaining(["from_wallet_id", "to_wallet_id", "from_statement_id", "to_statement_id"]));
  });

  test("the receiver's balance is right afterwards (a deposit to it records 50, not the sender's 60 + 10)", async () => {
    const s = given(opened("a", 100), opened("b", 0));
    await s.when(TransferMoney, { transferId: "t1", fromWalletId: "a", toWalletId: "b", amount: 40, description: "" });
    const r = await s.when(Deposit, dep("b", "d1", 10));
    expect(r.events.at(-1)!.data).toMatchObject({ newBalance: 50 });
  });

  test("refuses: insufficient funds on the sender, an unknown wallet on either side, and a wallet to itself", async () => {
    const s = given(opened("a", 10), opened("b", 0));
    const t = (from: string, to: string, amount: number) => ({ transferId: "t", fromWalletId: from, toWalletId: to, amount, description: "" });
    expect((await s.when(TransferMoney, t("a", "b", 100))).error).toBeInstanceOf(InsufficientFunds);
    expect((await s.when(TransferMoney, t("ghost", "b", 1))).error).toMatchObject({ _tag: "WalletNotFound", walletId: "ghost" });
    expect((await s.when(TransferMoney, t("a", "ghost", 1))).error).toMatchObject({ _tag: "WalletNotFound", walletId: "ghost" });
    expect((await s.when(TransferMoney, t("a", "a", 1))).error).toBeInstanceOf(InvalidInput);
  });
});

describe("CloseWallet", () => {
  test("closes an open wallet; afterwards it no longer exists for deposits, and a repeated close is already done", async () => {
    const s = given(opened("w1", 5));
    expect((await s.when(CloseWallet, { walletId: "w1" })).events.map((e) => e.type)).toEqual(["WalletClosed"]);
    expect((await s.when(Deposit, dep("w1", "d1"))).error).toBeInstanceOf(WalletNotFound);
    const again = await s.when(CloseWallet, { walletId: "w1" });
    expect(again.outcome).toBe("idempotent");
    expect(again.events).toEqual([]);
  });

  test("an unknown wallet is WalletNotFound", async () => {
    expect((await given().when(CloseWallet, { walletId: "ghost" })).error).toBeInstanceOf(WalletNotFound);
  });
});

// Every command the HTTP API exposes says how it recognises a repeat (ADR-0034), and keeps its word: a client that lost the first answer and sends
// the same request again gets "already done", never a second effect.
describe("a repeated request is harmless, for every command over HTTP", () => {
  // #region repeat-harmless
  test("open, deposit, withdraw, transfer, close", async () => {
    await assertRepeatHarmless(OpenWallet, { walletId: "w1", owner: "Ann", initialBalance: 50 });
    await assertRepeatHarmless(Deposit, dep("w1", "d1"), [opened("w1", 0)]);
    await assertRepeatHarmless(Withdraw, wd("w1", "x1", 5), [opened("w1", 50)]);
    await assertRepeatHarmless(TransferMoney, { transferId: "t1", fromWalletId: "a", toWalletId: "b", amount: 40, description: "" }, [opened("a", 100), opened("b", 0)]);
    await assertRepeatHarmless(CloseWallet, { walletId: "w1" }, [opened("w1", 0)]);
  });
  // #endregion repeat-harmless
});
