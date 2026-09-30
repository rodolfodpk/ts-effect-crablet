// Phase 2 gate: the declarative wallet model (src/domain/WalletModel.ts) must agree with the
// hand-written pieces it replaces - WalletQueryPatterns (the boundary queries), WalletEvents (the
// event constructors) and WalletBalanceProjector (the fold) - except where those have known bugs,
// which are asserted explicitly below.
import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import * as LogPosition from "@crablet/eventstore/LogPosition";
import * as Tag from "@crablet/eventstore/Tag";
import type { Query } from "@crablet/eventstore/Query";
import type { AppendEvent } from "@crablet/eventstore/AppendEvent";
import { all } from "@crablet/commands/Model";
import { makeInMemoryEventStore } from "@crablet/eventstore/testing/InMemoryEventStore";
import * as WalletEvents from "../src/domain/events/WalletEvents.ts";
import * as WalletQueryPatterns from "../src/domain/WalletQueryPatterns.ts";
import { walletBalanceProjector } from "../src/domain/WalletBalanceProjector.ts";
import * as M from "../src/domain/WalletModel.ts";

// The SET of (event type, tag set) pairs a query can match. Two queries are equivalent when these
// sets are equal, even if their items are grouped differently (two items with the same tags and
// different types == one item with both types).
const normal = (q: Query): ReadonlyArray<string> =>
  [
    ...new Set(
      q.items.flatMap((i) =>
        (i.eventTypes.length ? i.eventTypes : ["*"]).map(
          (t) => `${t}|${i.tags.map((x) => `${x.key}=${x.value}`).sort().join("&")}`
        )
      )
    )
  ].sort();

const tagSet = (e: AppendEvent) => e.tags.map((t) => `${t.key}=${t.value}`).sort();
const Y = 2026;
const MO = 9;
const periodTags = (walletId: string) => [
  Tag.of("year", String(Y)),
  Tag.of("month", String(MO)),
  Tag.of("statement_id", `wallet:${walletId}:${Y}-0${MO}`)
];

describe("boundary queries", () => {
  test("a wallet's period model matches WalletQueryPatterns.singleWalletActivePeriodDecisionModel", () => {
    expect(normal(M.WalletModel.of({ id: "w1", year: Y, month: MO }).query)).toEqual(
      normal(WalletQueryPatterns.singleWalletActivePeriodDecisionModel("w1", Y, MO))
    );
  });

  test("the lifecycle guard is structurally identical to WalletQueryPatterns.walletLifecycleModel", () => {
    expect(M.WalletModel.lifecycleQuery("w1")).toEqual(WalletQueryPatterns.walletLifecycleModel("w1"));
  });

  test("a two-wallet model matches WalletQueryPatterns.transferPeriodDecisionModel", () => {
    const both = all({
      from: M.WalletModel.of({ id: "a", year: Y, month: MO }),
      to: M.WalletModel.of({ id: "b", year: Y, month: MO })
    });
    expect(normal(both.query)).toEqual(normal(WalletQueryPatterns.transferPeriodDecisionModel("a", "b", Y, MO)));
  });
});

describe("event definitions produce the same events as the existing constructors", () => {
  const at = "2026-09-01T00:00:00.000Z";

  test("WalletOpened / WalletClosed", () => {
    const o = { walletId: "w1", owner: "Ann", initialBalance: 50, openedAt: at };
    expect(M.WalletOpened(o).type).toBe(WalletEvents.walletOpened(o).type);
    expect(tagSet(M.WalletOpened(o))).toEqual(tagSet(WalletEvents.walletOpened(o)));
    expect(M.WalletOpened(o).eventData).toEqual(WalletEvents.walletOpened(o).eventData);
    const c = { walletId: "w1", closedAt: at };
    expect(tagSet(M.WalletClosed(c))).toEqual(tagSet(WalletEvents.walletClosed(c)));
  });

  test("DepositMade / WithdrawalMade (with the period tags handlers add)", () => {
    const d = { depositId: "d1", walletId: "w1", amount: 5, newBalance: 55, depositedAt: at, description: "x" };
    expect(tagSet(M.DepositMade(d, periodTags("w1")))).toEqual(tagSet(WalletEvents.depositMade(d, periodTags("w1"))));
    const w = { withdrawalId: "x1", walletId: "w1", amount: 5, newBalance: 45, withdrawnAt: at, description: "x" };
    expect(tagSet(M.WithdrawalMade(w, periodTags("w1")))).toEqual(tagSet(WalletEvents.withdrawalMade(w, periodTags("w1"))));
  });

  test("MoneyTransferred", () => {
    const t = {
      transferId: "t1", fromWalletId: "a", toWalletId: "b", amount: 10,
      fromBalance: 90, toBalance: 10, transferredAt: at, description: "x"
    };
    expect(tagSet(M.MoneyTransferred(t, periodTags("a")))).toEqual(tagSet(WalletEvents.moneyTransferred(t, periodTags("a"))));
  });

  test("WalletStatementOpened / WalletStatementClosed", () => {
    const so = { walletId: "w1", statementId: "s1", year: Y, month: MO, openingBalance: 7, openedAt: at };
    expect(tagSet(M.WalletStatementOpened(so))).toEqual(tagSet(WalletEvents.walletStatementOpened(so)));
    const sc = { ...so, closingBalance: 9, closedAt: at };
    expect(tagSet(M.WalletStatementClosed(sc))).toEqual(tagSet(WalletEvents.walletStatementClosed(sc)));
  });
});

const at = "2026-09-01T00:00:00.000Z";
const stateOf = (fake: ReturnType<typeof makeInMemoryEventStore>, id: string) =>
  Effect.runPromise(M.WalletModel.of({ id, year: Y, month: MO }).load(fake.service)).then((l) => l.state);
const oldStateOf = (fake: ReturnType<typeof makeInMemoryEventStore>, id: string) =>
  Effect.runPromise(
    fake.service.project(
      WalletQueryPatterns.singleWalletActivePeriodDecisionModel(id, Y, MO),
      LogPosition.zero(),
      [walletBalanceProjector]
    )
  ).then((r) => r.state);

describe("state fold vs the existing WalletBalanceProjector", () => {
  test("agrees on a sequential history of opens, deposits, withdrawals and a statement", async () => {
    const fake = makeInMemoryEventStore();
    fake.seed(
      WalletEvents.walletOpened({ walletId: "w1", owner: "Ann", initialBalance: 100, openedAt: at }),
      WalletEvents.walletStatementOpened({ walletId: "w1", statementId: "s", year: Y, month: MO, openingBalance: 100, openedAt: at }),
      WalletEvents.depositMade({ depositId: "d1", walletId: "w1", amount: 25, newBalance: 125, depositedAt: at, description: "" }, periodTags("w1")),
      WalletEvents.withdrawalMade({ withdrawalId: "x1", walletId: "w1", amount: 40, newBalance: 85, withdrawnAt: at, description: "" }, periodTags("w1")),
      WalletEvents.depositMade({ depositId: "d2", walletId: "w1", amount: 15, newBalance: 100, depositedAt: at, description: "" }, periodTags("w1"))
    );
    expect(await stateOf(fake, "w1")).toEqual({ exists: true, balance: 100 });
    expect(await stateOf(fake, "w1")).toEqual(await oldStateOf(fake, "w1"));
  });

  test("agrees that a closed wallet no longer exists, and that an unknown wallet doesn't", async () => {
    const fake = makeInMemoryEventStore();
    fake.seed(
      WalletEvents.walletOpened({ walletId: "w1", owner: "Ann", initialBalance: 5, openedAt: at }),
      WalletEvents.walletClosed({ walletId: "w1", closedAt: at })
    );
    expect((await stateOf(fake, "w1")).exists).toBe(false);
    expect(await stateOf(fake, "w1")).toEqual(await oldStateOf(fake, "w1"));
    expect(await stateOf(fake, "ghost")).toEqual({ exists: false, balance: 0 });
  });

  test("agrees for the SENDER of a transfer", async () => {
    const fake = seededTransfer();
    expect((await stateOf(fake, "a")).balance).toBe(60);
    expect((await stateOf(fake, "a")).balance).toBe((await oldStateOf(fake, "a")).balance);
  });

  // KNOWN BUG in the existing projector (spike finding F2): it decides "which side of the transfer is
  // this wallet" by checking whether the event has a `from_wallet_id` tag - but both tags are on every
  // transfer event, so it always picks the sender's balance. The receiver's state was wrong (60, not
  // 40), and a deposit right after a transfer recorded a wrong `newBalance`.
  test("F2: the RECEIVER of a transfer gets the right balance (the existing projector does not)", async () => {
    const fake = seededTransfer();
    expect((await stateOf(fake, "b")).balance).toBe(40);
    expect((await oldStateOf(fake, "b")).balance).toBe(60); // documents the existing bug
  });

  // KNOWN BUG in the existing design (spike finding F3): the projector folds the `newBalance` snapshot
  // each writer computed from the state IT saw. Two deposits that ran concurrently both saw balance 50,
  // so they wrote snapshots 60 and 70; folding snapshots keeps only the last (70) and loses 10.
  test("F3: concurrent deposits are summed, not overwritten by the last stale snapshot", async () => {
    const fake = makeInMemoryEventStore();
    fake.seed(
      WalletEvents.walletOpened({ walletId: "w1", owner: "Ann", initialBalance: 50, openedAt: at }),
      WalletEvents.walletStatementOpened({ walletId: "w1", statementId: "s", year: Y, month: MO, openingBalance: 50, openedAt: at }),
      WalletEvents.depositMade({ depositId: "d1", walletId: "w1", amount: 10, newBalance: 60, depositedAt: at, description: "" }, periodTags("w1")),
      WalletEvents.depositMade({ depositId: "d2", walletId: "w1", amount: 20, newBalance: 70, depositedAt: at, description: "" }, periodTags("w1"))
    );
    expect((await stateOf(fake, "w1")).balance).toBe(80);
    expect((await oldStateOf(fake, "w1")).balance).toBe(70); // documents the existing lost update
  });
});

function seededTransfer() {
  const fake = makeInMemoryEventStore();
  fake.seed(
    WalletEvents.walletOpened({ walletId: "a", owner: "Ann", initialBalance: 100, openedAt: at }),
    WalletEvents.walletStatementOpened({ walletId: "a", statementId: "sa", year: Y, month: MO, openingBalance: 100, openedAt: at }),
    WalletEvents.walletOpened({ walletId: "b", owner: "Bob", initialBalance: 0, openedAt: at }),
    WalletEvents.walletStatementOpened({ walletId: "b", statementId: "sb", year: Y, month: MO, openingBalance: 0, openedAt: at }),
    WalletEvents.moneyTransferred(
      { transferId: "t1", fromWalletId: "a", toWalletId: "b", amount: 40, fromBalance: 60, toBalance: 40, transferredAt: at, description: "" },
      [...periodTags("a"), Tag.of("from_statement_id", "sa"), Tag.of("to_statement_id", "sb")]
    )
  );
  return fake;
}
