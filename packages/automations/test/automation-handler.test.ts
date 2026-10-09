import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import * as Schema from "effect/Schema";
import { defineCommand, noop } from "@crablet/commands/Command";
import { automationHandlerOf } from "../src/AutomationHandler.ts";
import { noOp } from "../src/AutomationDecision.ts";
import { testCommand } from "./fixtures/testCommand.ts";

describe("automationHandlerOf", () => {
  test("refuses a command with no idempotentBy: an automation can run the same batch twice, and that command would do its work twice", () => {
    const notIdempotent = defineCommand({ name: "NotIdempotent", input: Schema.Unknown, decide: () => noop() });
    expect(notIdempotent.idempotent).toBe(false);
    expect(() => automationHandlerOf("needs-idempotency", notIdempotent, () => Effect.succeed([noOp()]))).toThrow(
      /automation "needs-idempotency": command "NotIdempotent" has no idempotentBy/
    );
  });

  test("accepts a command that declares idempotentBy", () => {
    expect(testCommand.idempotent).toBe(true);
    expect(automationHandlerOf("fine", testCommand, () => Effect.succeed([noOp()])).automationName).toBe("fine");
  });
});
