import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import type { StoredEvent } from "@crablet/eventstore";
import type { EventDecodingError } from "@crablet/eventstore/EventDecoding";
import { walletOpenedAutomation } from "../src/automations/WalletOpenedAutomation.ts";
import * as WalletEvents from "../src/domain/events/WalletEvents.ts";

const event = (data: unknown): StoredEvent => ({
  type: WalletEvents.WALLET_OPENED,
  tags: [{ key: "wallet_id", value: "w1" }],
  data,
  transactionId: "9",
  position: 12n,
  occurredAt: new Date(0),
  correlationId: null,
  causationId: null
});

describe("the welcome automation reads WalletOpened through its definition", () => {
  test("a readable event becomes the command", async () => {
    const decisions = await Effect.runPromise(walletOpenedAutomation.decide(event({ walletId: "w1", owner: "Alice", initialBalance: 0, openedAt: new Date(0).toISOString() })));
    expect(decisions.length).toBe(1);
  });

  test("an unreadable one is a typed failure naming it, so the processor records it against the automation instead of sending a notification built from nothing", async () => {
    const exit = await Effect.runPromiseExit(walletOpenedAutomation.decide(event({ owner: "Alice" })));
    expect(exit._tag).toBe("Failure");
    if (exit._tag !== "Failure") return;
    const error = exit.cause.reasons.filter((r) => r._tag === "Fail").map((r) => (r as { error: EventDecodingError }).error)[0]!;
    expect(error).toMatchObject({ _tag: "EventDecodingError", type: WalletEvents.WALLET_OPENED, position: 12n, transactionId: "9" });
    expect(error.issues.some((i) => i.path[0] === "walletId")).toBe(true);
  });
});
