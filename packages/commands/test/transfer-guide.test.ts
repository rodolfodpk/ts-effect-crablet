// The DCB guide's transfer example with no database (in-memory store, real command pipeline).
import { describe, expect, test } from "bun:test";
import { given } from "../src/testing/Scenario.ts";
import { AccountNotFound, AccountOpened, Deposited, InsufficientFunds, Transfer } from "./support/transfer.ts";

const open = (accountId: string, balance: number) => AccountOpened({ accountId, balance });
const t = (transferId: string, from: string, to: string, amount: number) => ({ transferId, from, to, amount });

describe("transfer", () => {
  test("moves money: one Transferred event, found through both accounts", async () => {
    const s = given(open("a", 100), open("b", 0));
    const r = await s.when(Transfer, t("t1", "a", "b", 40));
    expect(r.outcome).toBe("created");
    expect(r.events.map((e) => e.type)).toEqual(["Transferred"]);
    expect(r.events[0]!.tags.map((x) => `${x.key}=${x.value}`).sort()).toEqual(["from_account_id=a", "to_account_id=b", "transfer_id=t1"]);
  });

  test("later decisions see earlier transfers on BOTH sides", async () => {
    const s = given(open("a", 100), open("b", 0));
    await s.when(Transfer, t("t1", "a", "b", 40)); // a=60, b=40
    expect((await s.when(Transfer, t("t2", "a", "b", 60))).outcome).toBe("created"); // a=0, b=100
    expect((await s.when(Transfer, t("t3", "a", "b", 1))).error).toBeInstanceOf(InsufficientFunds);
    expect((await s.when(Transfer, t("t4", "b", "a", 100))).outcome).toBe("created"); // the receiver can spend what it got
  });

  test("a deposit counts too", async () => {
    const s = given(open("a", 10), open("b", 0), Deposited({ accountId: "a", amount: 90 }));
    expect((await s.when(Transfer, t("t1", "a", "b", 100))).outcome).toBe("created");
  });

  test("refuses overspending and unknown accounts, appending nothing", async () => {
    const s = given(open("a", 10), open("b", 0));
    const over = await s.when(Transfer, t("t1", "a", "b", 11));
    expect(over.error).toBeInstanceOf(InsufficientFunds);
    expect(over.events).toEqual([]);
    expect((await s.when(Transfer, t("t2", "a", "ghost", 1))).error).toBeInstanceOf(AccountNotFound);
    expect((await s.when(Transfer, t("t3", "ghost", "b", 1))).error).toBeInstanceOf(AccountNotFound);
    expect(s.log.filter((e) => e.type === "Transferred")).toHaveLength(0);
  });

  test("repeating a transfer id is 'already done', even though the money has moved", async () => {
    const s = given(open("a", 50), open("b", 0));
    await s.when(Transfer, t("t1", "a", "b", 50)); // a is now empty: re-deciding would fail
    const again = await s.when(Transfer, t("t1", "a", "b", 50));
    expect(again.outcome).toBe("idempotent");
    expect(s.log.filter((e) => e.type === "Transferred")).toHaveLength(1);
  });
});
