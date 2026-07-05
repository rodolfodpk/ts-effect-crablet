import { describe, expect, test } from "bun:test";
import { viewSubscriptionOf } from "../src/ViewSubscription.ts";

describe("viewSubscriptionOf", () => {
  test("fills EventSelection defaults when omitted", () => {
    const sub = viewSubscriptionOf("wallet-view");
    expect(sub.viewName).toBe("wallet-view");
    expect(sub.eventTypes.size).toBe(0);
    expect(sub.requiredTags.size).toBe(0);
    expect(sub.anyOfTags.size).toBe(0);
    expect(sub.exactTags.size).toBe(0);
    expect(sub.pollingIntervalMs).toBeUndefined();
  });

  test("carries provided EventSelection + override fields", () => {
    const sub = viewSubscriptionOf("wallet-view", {
      eventTypes: new Set(["MoneyDeposited"]),
      requiredTags: new Set(["wallet_id"]),
      pollingIntervalMs: 500,
      backoffEnabled: false
    });
    expect([...sub.eventTypes]).toEqual(["MoneyDeposited"]);
    expect([...sub.requiredTags]).toEqual(["wallet_id"]);
    expect(sub.pollingIntervalMs).toBe(500);
    expect(sub.backoffEnabled).toBe(false);
    expect(sub.batchSize).toBeUndefined();
  });
});
