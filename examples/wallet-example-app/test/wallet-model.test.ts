// The declarative wallet model (src/domain/WalletModel.ts): its boundary queries and its state fold.
// (While the hand-written WalletQueryPatterns/WalletBalanceProjector still existed, this file proved the
// model equal to them; they are gone, so the expectations are now written out directly.)
import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import * as Query from "@crablet/eventstore/Query";
import * as Tag from "@crablet/eventstore/Tag";
import { all } from "@crablet/commands/Model";
import { makeInMemoryEventStore } from "@crablet/eventstore/testing/InMemoryEventStore";
import * as M from "../src/domain/WalletModel.ts";

const Y = 2026;
const MO = 9;
const at = "2026-09-01T00:00:00.000Z";
const period = (walletId: string, month = MO) =>
  M.periodTags(walletId, { key: `${Y}-0${month}`, fields: { year: Y, month }, tags: [Tag.of("year", String(Y)), Tag.of("month", String(month))] });

const item = (types: string[], tags: Array<[string, string]>) => Query.queryItemOf(types, tags.map(([k, v]) => Tag.of(k, v)));
// the wallet's boundary for one period: its lifecycle events, plus that period's statement events,
// deposits/withdrawals, and transfers in either direction
const periodItems = (w: string) => [
  item(["WalletOpened", "WalletClosed"], [["wallet_id", w]]),
  item(["WalletStatementOpened", "DepositMade", "WithdrawalMade"], [["wallet_id", w], ["year", String(Y)], ["month", String(MO)]]),
  item(["MoneyTransferred"], [["from_wallet_id", w], ["year", String(Y)], ["month", String(MO)]]),
  item(["MoneyTransferred"], [["to_wallet_id", w], ["year", String(Y)], ["month", String(MO)]])
];

describe("boundary queries", () => {
  test("a wallet's period model: lifecycle unscoped; statements, deposits, withdrawals and transfers scoped to the period", () => {
    expect(M.WalletModel.of({ id: "w1", year: Y, month: MO }).query).toEqual(Query.of(periodItems("w1")));
  });

  test("the lifecycle guard is only the open/close events", () => {
    expect(M.WalletModel.lifecycleQuery("w1")).toEqual(Query.of([item(["WalletOpened", "WalletClosed"], [["wallet_id", "w1"]])]));
    expect(M.WalletLifecycleModel.of({ id: "w1" }).query).toEqual(M.WalletModel.lifecycleQuery("w1"));
  });

  test("a two-wallet model is the union of both wallets' boundaries", () => {
    const both = all({ from: M.WalletModel.of({ id: "a", year: Y, month: MO }), to: M.WalletModel.of({ id: "b", year: Y, month: MO }) });
    expect(both.query).toEqual(Query.of([...periodItems("a"), ...periodItems("b")]));
  });
});

describe("events", () => {
  test("carry the tags derived from their payload, plus the period tags commands add", () => {
    const deposit = M.DepositMade(
      { depositId: "d1", walletId: "w1", amount: 5, newBalance: 55, depositedAt: at, description: "x" },
      period("w1")
    );
    expect(deposit.tags.map((t) => `${t.key}=${t.value}`).sort()).toEqual(
      ["deposit_id=d1", "month=9", "statement_id=wallet:w1:2026-09", "wallet_id=w1", "year=2026"].sort()
    );
    const transfer = M.MoneyTransferred({
      transferId: "t1", fromWalletId: "a", toWalletId: "b", amount: 1, fromBalance: 0, toBalance: 1, transferredAt: at, description: ""
    });
    expect(transfer.tags.map((t) => `${t.key}=${t.value}`).sort()).toEqual(["from_wallet_id=a", "to_wallet_id=b", "transfer_id=t1"]);
  });

  test("a statement event's optional month is tagged only when present", () => {
    const withMonth = M.WalletStatementOpened({ walletId: "w", statementId: "s", year: Y, month: MO, openingBalance: 0, openedAt: at });
    const withoutMonth = M.WalletStatementOpened({ walletId: "w", statementId: "s", year: Y, openingBalance: 0, openedAt: at });
    expect(withMonth.tags.map((t) => t.key)).toContain("month");
    expect(withoutMonth.tags.map((t) => t.key)).not.toContain("month");
  });
});

const stateOf = (fake: ReturnType<typeof makeInMemoryEventStore>, id: string, month = MO) =>
  Effect.runPromise(M.WalletModel.of({ id, year: Y, month }).load(fake.service)).then((l) => l.state);

const open = (id: string, initialBalance: number) => M.WalletOpened({ walletId: id, owner: "x", initialBalance, openedAt: at });
const statement = (id: string, openingBalance: number, month = MO) =>
  M.WalletStatementOpened({ walletId: id, statementId: `wallet:${id}:${Y}-0${month}`, year: Y, month, openingBalance, openedAt: at });
const deposit = (id: string, n: string, amount: number, newBalance: number) =>
  M.DepositMade({ depositId: n, walletId: id, amount, newBalance, depositedAt: at, description: "" }, period(id));
const withdrawal = (id: string, n: string, amount: number, newBalance: number) =>
  M.WithdrawalMade({ withdrawalId: n, walletId: id, amount, newBalance, withdrawnAt: at, description: "" }, period(id));
const transfer = (from: string, to: string, amount: number) =>
  M.MoneyTransferred(
    { transferId: "t1", fromWalletId: from, toWalletId: to, amount, fromBalance: 0, toBalance: 0, transferredAt: at, description: "" },
    [...period(from), Tag.of("from_statement_id", "sf"), Tag.of("to_statement_id", "st")]
  );

describe("state fold", () => {
  test("opens with the initial balance, then deposits and withdrawals change it", async () => {
    const fake = makeInMemoryEventStore();
    fake.seed(open("w1", 100), statement("w1", 100), deposit("w1", "d1", 25, 125), withdrawal("w1", "x1", 40, 85), deposit("w1", "d2", 15, 100));
    expect(await stateOf(fake, "w1")).toEqual({ exists: true, balance: 100 });
  });

  test("a closed wallet no longer exists; an unknown wallet never did", async () => {
    const fake = makeInMemoryEventStore();
    fake.seed(open("w1", 5), M.WalletClosed({ walletId: "w1", closedAt: at }));
    expect((await stateOf(fake, "w1")).exists).toBe(false);
    expect(await stateOf(fake, "ghost")).toEqual({ exists: false, balance: 0 });
  });

  test("the balance carries forward into a new period through the statement's opening balance", async () => {
    const fake = makeInMemoryEventStore();
    fake.seed(open("w1", 100), statement("w1", 100, 8), deposit("w1", "d1", 50, 150));
    // a later period opens with the carried-forward balance, and only that period's transactions count
    fake.seed(statement("w1", 150, 9));
    expect((await stateOf(fake, "w1", 9)).balance).toBe(150);
  });

  // Regression: the old hand-written projector decided "which side of the transfer is this wallet" by
  // checking for a `from_wallet_id` TAG, but both tags are on every transfer, so it always picked the
  // sender's balance - the receiver's state was wrong (60 instead of 40).
  test("both sides of a transfer are right: the sender loses and the RECEIVER gains", async () => {
    const fake = makeInMemoryEventStore();
    fake.seed(open("a", 100), statement("a", 100), open("b", 0), statement("b", 0), transfer("a", "b", 40));
    expect((await stateOf(fake, "a")).balance).toBe(60);
    expect((await stateOf(fake, "b")).balance).toBe(40);
  });

  // Regression: the old projector folded the `newBalance` snapshot each writer computed from the state IT
  // saw. Two deposits that ran concurrently both saw 50, so they wrote snapshots 60 and 70; folding
  // snapshots kept only the last (70) and lost 10. Summing amounts keeps both.
  test("concurrent deposits (stale newBalance snapshots) are summed, not overwritten", async () => {
    const fake = makeInMemoryEventStore();
    fake.seed(open("w1", 50), statement("w1", 50), deposit("w1", "d1", 10, 60), deposit("w1", "d2", 20, 70));
    expect((await stateOf(fake, "w1")).balance).toBe(80);
  });
});
