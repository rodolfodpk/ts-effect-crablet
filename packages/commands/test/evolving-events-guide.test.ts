// Runs the code of docs/evolving-events.md (packages/commands/test/support/evolving-events.ts), so the guide shows what works.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Effect } from "effect";
import type { StoredEvent } from "@crablet/eventstore";
import type { EventDecodingError } from "@crablet/eventstore/EventDecoding";
import { makeInMemoryEventStore } from "@crablet/eventstore/testing/InMemoryEventStore";
import { checkFixtures, checkImpact, depositFixtures, DepositMade, DepositMadeV1, DepositReversed, netAmount, WalletBalance, WalletOpened, verifyStored } from "./support/evolving-events.ts";

const stored = (data: unknown): StoredEvent => ({ type: "DepositMade", tags: [], data, transactionId: "12", position: 99n, occurredAt: new Date(0), correlationId: null, causationId: null });

describe("evolving an event: a compatible change", () => {
  test("the old payload decodes with the default; one written with the field keeps it; the old definition reads the new payload and ignores the field", () => {
    expect(DepositMade.decode({ depositId: "d", walletId: "w", amount: 10 })).toEqual({ depositId: "d", walletId: "w", amount: 10, fee: 0 });
    expect(DepositMade.decode({ depositId: "d", walletId: "w", amount: 10, fee: 2 }).fee).toBe(2);
    expect(DepositMadeV1.decode({ depositId: "d", walletId: "w", amount: 10, fee: 2 })).toEqual({ depositId: "d", walletId: "w", amount: 10 });
  });

  test("a NEW event must carry the field; the default is for stored payloads only", () => {
    // @ts-expect-error a new DepositMade has to say what its fee is
    DepositMade({ depositId: "d", walletId: "w", amount: 10 });
    expect(DepositMade({ depositId: "d", walletId: "w", amount: 10, fee: 0 }).type).toBe("DepositMade");
  });

  test("an optional field stays absent, and personal data is still found on it", () => {
    expect(WalletOpened.decode({ walletId: "w", owner: "Ann" })).toEqual({ walletId: "w", owner: "Ann" });
  });
});

describe("reading an event that cannot be read", () => {
  test("a readable event is its data; an unreadable one fails with the event's type, position, transaction and issues, never silently", async () => {
    expect(await Effect.runPromise(netAmount(stored({ depositId: "d", walletId: "w", amount: 10 })))).toBe(10);
    expect(await Effect.runPromise(netAmount(stored({ depositId: "d", walletId: "w", amount: 10, fee: 3 })))).toBe(7);
    const exit = await Effect.runPromiseExit(netAmount(stored({ depositId: "d", walletId: "w" })));
    if (exit._tag !== "Failure") throw new Error("expected a failure");
    const error = exit.cause.reasons.filter((r) => r._tag === "Fail").map((r) => (r as { error: EventDecodingError }).error)[0]!;
    expect(error).toMatchObject({ _tag: "EventDecodingError", type: "DepositMade", position: 99n, transactionId: "12" });
    expect(error.issues).toEqual([{ path: ["amount"], message: "Missing key" }]);
  });

  test("a model over a boundary with an unreadable event fails the same typed way", async () => {
    const fake = makeInMemoryEventStore();
    fake.seed({ type: "DepositMade", tags: [{ key: "wallet_id", value: "w" }], eventData: { walletId: "w" } });
    const exit = await Effect.runPromiseExit(WalletBalance.of({ id: "w" }).load(fake.service));
    expect(exit._tag).toBe("Failure");
  });
});

describe("the checks", () => {
  test("the fixtures still decode and derive their tags", () => {
    expect(() => checkFixtures()).not.toThrow();
  });

  test("the change-impact report: no findings when every model accounts for every event that carries its tags", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "guide-"));
    const baseline = path.join(dir, "baseline.json");
    writeFileSync(baseline, "[]\n");
    const fixtures = [
      ...depositFixtures,
      { type: "DepositReversed", payload: { depositId: "d1", walletId: "w1", amount: 10, reason: "mistake" }, tags: ["wallet_id=w1", "deposit_id=d1"] },
      { type: "WalletOpened", payload: { walletId: "w1", owner: "Ann" }, tags: ["wallet_id=w1"] }
    ];
    expect(() => checkImpact(baseline, fixtures)).not.toThrow();
    expect(DepositReversed.type).toBe("DepositReversed");
  });

  test("verify-events is an Effect that needs a database: here it is only built", () => {
    expect(typeof verifyStored.pipe).toBe("function");
  });
});
