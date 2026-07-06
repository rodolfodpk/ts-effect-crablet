import { describe, expect, test } from "bun:test";
import { executeCommand, noOp } from "../src/AutomationDecision.ts";

describe("AutomationDecision constructors", () => {
  test("executeCommand wraps the given command", () => {
    const decision = executeCommand({ orderId: "o-1" });
    expect(decision).toEqual({ _tag: "ExecuteCommand", command: { orderId: "o-1" } });
  });

  test("noOp carries no payload", () => {
    expect(noOp()).toEqual({ _tag: "NoOp" });
  });
});
