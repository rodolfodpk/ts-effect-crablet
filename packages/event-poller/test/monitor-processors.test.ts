import { describe, expect, test } from "bun:test";
import { Effect, Fiber, Metric } from "effect";
import * as PollerMetrics from "@crablet/metrics-otel/PollerMetrics";
import { monitorProcessors, recordProcessorSamples, sampleProcessors } from "../src/MonitorProcessors.ts";
import type { Backlog, ProcessorManagementService } from "../src/ProcessorManagementService.ts";
import type { ProcessorStatus } from "../src/ProcessorStatus.ts";
import * as ProgressCursorNS from "../src/ProgressCursor.ts";

const run = <A, E>(effect: Effect.Effect<A, E, never>) => Effect.runPromise(effect);
const gauge = (metric: typeof PollerMetrics.lagEvents, attributes: Record<string, string>) =>
  Effect.map(Metric.value(Metric.withAttributes(metric, attributes)), (s) => (s as unknown as { value: number }).value);

// Only the two calls the sampler makes.
const fakeService = (
  statuses: ReadonlyArray<readonly [string, ProcessorStatus]>,
  backlogOf: (id: string) => Effect.Effect<Backlog | null, unknown>
): ProcessorManagementService<string> =>
  ({ getAllStatuses: Effect.succeed(new Map(statuses)), getBacklog: backlogOf }) as unknown as ProcessorManagementService<string>;

const backlog = (pendingEvents: number, oldestPendingSeconds: number | null, position = 10n): Backlog => ({
  cursor: ProgressCursorNS.of("5", position),
  pendingEvents,
  capped: false,
  oldestPendingSeconds
});

describe("sampleProcessors", () => {
  test("reports status, cursor position, pending events, and the age of the oldest (0 when caught up)", async () => {
    const service = fakeService(
      [["behind", "ACTIVE"], ["caught-up", "PAUSED"]],
      (id) => Effect.succeed(id === "behind" ? backlog(7, 42.5, 100n) : backlog(0, null, 200n))
    );
    expect(await run(sampleProcessors(service))).toEqual([
      { processor: "behind", status: "ACTIVE", cursorPosition: 100n, lagEvents: 7, lagSeconds: 42.5 },
      { processor: "caught-up", status: "PAUSED", cursorPosition: 200n, lagEvents: 0, lagSeconds: 0 }
    ]);
  });

  test("a processor whose selection is unknown, or whose backlog cannot be read, is still reported with its status and nothing else", async () => {
    const service = fakeService(
      [["unknown", "ACTIVE"], ["broken", "FAILED"], ["fine", "ACTIVE"]],
      (id) => id === "broken" ? Effect.fail(new Error("connection reset")) : Effect.succeed(id === "fine" ? backlog(1, 1) : null)
    );
    const samples = await run(sampleProcessors(service));
    expect(samples.map((s) => [s.processor, s.status, s.lagEvents])).toEqual([["unknown", "ACTIVE", null], ["broken", "FAILED", null], ["fine", "ACTIVE", 1]]);
  });

  test("statuses that cannot be read give no samples rather than failing", async () => {
    const service = { getAllStatuses: Effect.fail(new Error("down")), getBacklog: () => Effect.succeed(null) } as unknown as ProcessorManagementService<string>;
    expect(await run(sampleProcessors(service))).toEqual([]);
  });
});

describe("recordProcessorSamples", () => {
  test("sets the lag, the cursor and one status gauge per status (1 for the current one)", async () => {
    const tags = { processor: "p-record", instance_id: "i1" };
    const read = await run(Effect.gen(function* () {
      yield* recordProcessorSamples([{ processor: "p-record", status: "PAUSED", cursorPosition: 123n, lagEvents: 9, lagSeconds: 3.5 }], "i1");
      return {
        lagEvents: yield* gauge(PollerMetrics.lagEvents, tags),
        lagSeconds: yield* gauge(PollerMetrics.lagSeconds, tags),
        cursor: yield* gauge(PollerMetrics.cursorPosition, tags),
        active: yield* gauge(PollerMetrics.status, { ...tags, status: "ACTIVE" }),
        paused: yield* gauge(PollerMetrics.status, { ...tags, status: "PAUSED" }),
        failed: yield* gauge(PollerMetrics.status, { ...tags, status: "FAILED" })
      };
    }));
    expect(read).toEqual({ lagEvents: 9, lagSeconds: 3.5, cursor: 123, active: 0, paused: 1, failed: 0 });
  });

  test("a status change moves the 1, and a sample without a backlog leaves the earlier lag as it was", async () => {
    const tags = { processor: "p-change", instance_id: "i1" };
    const read = await run(Effect.gen(function* () {
      yield* recordProcessorSamples([{ processor: "p-change", status: "ACTIVE", cursorPosition: 5n, lagEvents: 4, lagSeconds: 1 }], "i1");
      yield* recordProcessorSamples([{ processor: "p-change", status: "FAILED", cursorPosition: null, lagEvents: null, lagSeconds: null }], "i1");
      return {
        active: yield* gauge(PollerMetrics.status, { ...tags, status: "ACTIVE" }),
        failed: yield* gauge(PollerMetrics.status, { ...tags, status: "FAILED" }),
        lagEvents: yield* gauge(PollerMetrics.lagEvents, tags)
      };
    }));
    expect(read).toEqual({ active: 0, failed: 1, lagEvents: 4 });
  });
});

describe("monitorProcessors", () => {
  test("keeps the gauges current while its fiber lives, covers every service, and survives a round that fails", async () => {
    let calls = 0;
    const flaky = fakeService([["p-flaky", "ACTIVE"]], () => {
      calls++;
      return calls === 1 ? Effect.die(new Error("boom")) : Effect.succeed(backlog(calls, 1));
    });
    const other = fakeService([["p-other", "ACTIVE"]], () => Effect.succeed(backlog(77, 2)));
    const read = await run(Effect.gen(function* () {
      const fiber = yield* Effect.forkChild(monitorProcessors([flaky, other], { every: "10 millis", instanceId: "i-mon" }));
      yield* Effect.sleep("200 millis");
      yield* Fiber.interrupt(fiber);
      return {
        flaky: yield* gauge(PollerMetrics.lagEvents, { processor: "p-flaky", instance_id: "i-mon" }),
        other: yield* gauge(PollerMetrics.lagEvents, { processor: "p-other", instance_id: "i-mon" })
      };
    }));
    expect(calls).toBeGreaterThan(2);
    expect(read.flaky).toBeGreaterThan(1);
    expect(read.other).toBe(77);
  });
});
