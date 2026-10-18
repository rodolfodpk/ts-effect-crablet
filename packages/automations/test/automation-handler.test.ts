import { describe, expect, test } from "bun:test";
import { Cause, Effect, Exit } from "effect";
import * as Schema from "effect/Schema";
import { defineCommand, noop } from "@crablet/commands/Command";
import { defineEvent } from "@crablet/commands/Event";
import * as Tag from "@crablet/eventstore/Tag";
import type { StoredEvent } from "@crablet/eventstore";
import { defineAutomation } from "../src/AutomationHandler.ts";
import { testCommand } from "./fixtures/testCommand.ts";

const OrderPlaced = defineEvent("AH_OrderPlaced", {
  schema: Schema.Struct({ orderId: Schema.String, lines: Schema.Number }),
  tags: (d) => ({ order_id: d.orderId })
});
const stored = (type: string, data: unknown, tags: ReadonlyArray<Tag.Tag> = []): StoredEvent =>
  ({ type, data, tags, position: 7n, transactionId: "1", occurredAt: new Date(0), correlationId: null, causationId: null, eventId: "e" }) as unknown as StoredEvent;
const inputsOf = (automation: ReturnType<typeof defineAutomation<unknown>>, event: StoredEvent) =>
  Effect.runPromise(Effect.map(automation.decide(event), (ds) => ds.map((d) => (d._tag === "ExecuteCommand" ? d.input : null))));

describe("defineAutomation", () => {
  test("refuses a command with no idempotentBy: an automation can run the same batch twice, and that command would do its work twice", () => {
    const notIdempotent = defineCommand({ name: "NotIdempotent", input: Schema.Unknown, decide: () => noop() });
    expect(() => defineAutomation("needs-idempotency", notIdempotent)).toThrow(/automation "needs-idempotency": command "NotIdempotent" has no idempotentBy/);
  });

  test("selects the event types its handlers are declared for, plus the selection it is given", () => {
    const a = defineAutomation("a", testCommand, { anyOfTags: new Set(["order_id"]) }).on(OrderPlaced, () => undefined);
    expect([...a.eventTypes]).toEqual(["AH_OrderPlaced"]);
    expect([...a.anyOfTags]).toEqual(["order_id"]);
    expect(a.handles).toEqual(["AH_OrderPlaced"]);
  });

  test("a handler asks for one request, several, or none; the event is decoded with its own definition and its tags are in ctx", async () => {
    const event = stored("AH_OrderPlaced", { orderId: "o1", lines: 2 }, [Tag.of("order_id", "o1")]);
    const one = defineAutomation("one", testCommand).on(OrderPlaced, (d, ctx) => ({ order: d.orderId, tag: ctx.tag("order_id"), at: ctx.position }));
    const many = defineAutomation("many", testCommand).on(OrderPlaced, (d) => Array.from({ length: d.lines }, (_, i) => ({ line: i })));
    const none = defineAutomation("none", testCommand).on(OrderPlaced, () => undefined);
    expect(await inputsOf(one, event)).toEqual([{ order: "o1", tag: "o1", at: 7n }]);
    expect(await inputsOf(many, event)).toEqual([{ line: 0 }, { line: 1 }]);
    expect(await inputsOf(none, event)).toEqual([]);
    expect(await inputsOf(one, stored("Other", {}))).toEqual([]);
  });

  test("an event its definition cannot read fails with EventDecodingError, never skipped", async () => {
    const one = defineAutomation("one", testCommand).on(OrderPlaced, (d) => d.orderId);
    const exit = await Effect.runPromiseExit(one.decide(stored("AH_OrderPlaced", { orderId: 1 })));
    expect(Exit.isFailure(exit) && Cause.pretty(exit.cause)).toContain("EventDecodingError");
  });

  test("a second handler for the same event type is refused", () => {
    expect(() => defineAutomation("twice", testCommand).on(OrderPlaced, () => undefined).on(OrderPlaced, () => undefined)).toThrow(/already declared/);
  });
});
