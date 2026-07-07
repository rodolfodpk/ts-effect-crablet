import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import type { StoredEvent } from "@crablet/eventstore";
import * as CorrelationContext from "@crablet/eventstore/CorrelationContext";
import * as CD from "@crablet/commands/CommandDecision";
import { makeAutomationEventHandler, type ExecuteDecision } from "../src/internal/AutomationEventHandler.ts";
import { automationHandlerOf } from "../src/AutomationHandler.ts";
import { executeCommand, noOp } from "../src/AutomationDecision.ts";

const fakeEvent = (position: bigint, correlationId: string | null = null): StoredEvent => ({
  type: "OrderPlaced",
  tags: [],
  data: {},
  transactionId: "1",
  position,
  occurredAt: new Date(),
  correlationId,
  causationId: null
});

describe("makeAutomationEventHandler", () => {
  test("routes to the automation matching the given automationName", async () => {
    const seenA: Array<string> = [];
    const seenB: Array<string> = [];
    const automationA = automationHandlerOf(
      "automation-a",
      "TestCommand",
      () => Effect.succeed(CD.noOp()),
      () => Effect.sync(() => (seenA.push("decided"), [noOp()]))
    );
    const automationB = automationHandlerOf(
      "automation-b",
      "TestCommand",
      () => Effect.succeed(CD.noOp()),
      () => Effect.sync(() => (seenB.push("decided"), [noOp()]))
    );
    const executeDecision: ExecuteDecision = () => Effect.succeed(undefined);
    const handler = makeAutomationEventHandler([automationA, automationB], executeDecision);

    const handled = await Effect.runPromise(handler.handle("automation-b", [fakeEvent(1n)]));

    expect(handled).toBe(1);
    expect(seenA).toEqual([]);
    expect(seenB).toEqual(["decided"]);
  });

  test("dies on an unregistered automation name", async () => {
    const automation = automationHandlerOf(
      "automation-a",
      "TestCommand",
      () => Effect.succeed(CD.noOp()),
      () => Effect.succeed([noOp()])
    );
    const executeDecision: ExecuteDecision = () => Effect.succeed(undefined);
    const handler = makeAutomationEventHandler([automation], executeDecision);

    await expect(Effect.runPromise(handler.handle("unknown-automation", []))).rejects.toThrow();
  });

  test("NoOp decisions count the trigger event as processed without executing anything", async () => {
    const executed: Array<unknown> = [];
    const automation = automationHandlerOf(
      "automation-a",
      "TestCommand",
      () => Effect.succeed(CD.noOp()),
      () => Effect.succeed([noOp()])
    );
    const executeDecision: ExecuteDecision = (_commandType, command) =>
      Effect.sync(() => (executed.push(command), undefined));
    const handler = makeAutomationEventHandler([automation], executeDecision);

    const handled = await Effect.runPromise(handler.handle("automation-a", [fakeEvent(1n), fakeEvent(2n)]));

    expect(handled).toBe(2);
    expect(executed).toEqual([]);
  });

  test("executes ExecuteCommand decisions sequentially, in returned order", async () => {
    const executed: Array<unknown> = [];
    const automation = automationHandlerOf(
      "automation-a",
      "TestCommand",
      () => Effect.succeed(CD.noOp()),
      (event) => Effect.succeed([executeCommand({ step: "first", position: event.position }), executeCommand({ step: "second", position: event.position })])
    );
    const executeDecision: ExecuteDecision = (_commandType, command) =>
      Effect.sync(() => (executed.push(command), undefined));
    const handler = makeAutomationEventHandler([automation], executeDecision);

    const handled = await Effect.runPromise(handler.handle("automation-a", [fakeEvent(1n)]));

    expect(handled).toBe(1);
    expect(executed).toEqual([
      { step: "first", position: 1n },
      { step: "second", position: 1n }
    ]);
  });

  test("propagates the trigger event's causation/correlation ids into the executed decision", async () => {
    const seenIds: Array<{ correlationId: string | null; causationId: bigint | null }> = [];
    const automation = automationHandlerOf(
      "automation-a",
      "TestCommand",
      () => Effect.succeed(CD.noOp()),
      () => Effect.succeed([executeCommand({ noop: true })])
    );
    const executeDecision: ExecuteDecision = () =>
      Effect.gen(function* () {
        seenIds.push({
          correlationId: yield* CorrelationContext.correlationId,
          causationId: yield* CorrelationContext.causationId
        });
      });
    const handler = makeAutomationEventHandler([automation], executeDecision);

    await Effect.runPromise(handler.handle("automation-a", [fakeEvent(42n, "corr-1")]));

    expect(seenIds).toEqual([{ correlationId: "corr-1", causationId: 42n }]);
  });

  test("processes multiple trigger events in order, each decided independently", async () => {
    const decidedPositions: Array<bigint> = [];
    const automation = automationHandlerOf(
      "automation-a",
      "TestCommand",
      () => Effect.succeed(CD.noOp()),
      (event) => Effect.sync(() => (decidedPositions.push(event.position), [noOp()]))
    );
    const executeDecision: ExecuteDecision = () => Effect.succeed(undefined);
    const handler = makeAutomationEventHandler([automation], executeDecision);

    const events = [fakeEvent(1n), fakeEvent(2n), fakeEvent(3n)];
    const handled = await Effect.runPromise(handler.handle("automation-a", events));

    expect(handled).toBe(3);
    expect(decidedPositions).toEqual([1n, 2n, 3n]);
  });
});
