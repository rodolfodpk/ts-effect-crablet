import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { makeInMemoryProgressTracker } from "./fixtures/InMemoryProgressTracker.ts";
import { makeProcessorManagementService } from "../src/ProcessorManagementService.ts";
import type { SqlClient } from "@effect/sql";

const KNOWN_IDS = ["view-a", "view-b"] as const;

// A management service wired against an in-memory ProgressTracker and a fixed set of "known"
// processorIds (mirroring EventProcessor's getAllStatuses, which enumerates configured
// processorIds, not whichever rows happen to exist in the progress table).
const setup = () =>
  Effect.gen(function* () {
    const { tracker } = yield* makeInMemoryProgressTracker<string>();
    for (const id of KNOWN_IDS) yield* tracker.autoRegister(id, "test-instance");

    const getAllStatuses = Effect.map(
      Effect.forEach(KNOWN_IDS, (id) => Effect.map(tracker.getStatus(id), (status) => [id, status] as const)),
      (entries) => new Map(entries)
    );

    const management = makeProcessorManagementService({
      progressTracker: tracker,
      getAllStatuses,
      pauseProcessor: (id) => tracker.setStatus(id, "PAUSED"),
      resumeProcessor: (id) => tracker.setStatus(id, "ACTIVE"),
      backoffSnapshot: () => Effect.succeed(null),
      allBackoffSnapshots: Effect.succeed(new Map()),
      sql: null as unknown as SqlClient.SqlClient // unused by pause/resume/reset/getStatus
    });

    return { tracker, management };
  });

const run = <A, E>(effect: Effect.Effect<A, E, never>) => Effect.runPromise(effect);

describe("ProcessorManagementService lifecycle", () => {
  test("pause/resume/reset return false for an unknown processorId", async () => {
    const { management } = await run(setup());
    expect(await run(management.pause("nonexistent"))).toBe(false);
    expect(await run(management.resume("nonexistent"))).toBe(false);
    expect(await run(management.reset("nonexistent"))).toBe(false);
  });

  test("pause sets status to PAUSED for a known processorId", async () => {
    const { tracker, management } = await run(setup());
    expect(await run(management.pause("view-a"))).toBe(true);
    expect(await run(tracker.getStatus("view-a"))).toBe("PAUSED");
  });

  test("resume sets status back to ACTIVE", async () => {
    const { tracker, management } = await run(setup());
    await run(management.pause("view-a"));
    expect(await run(management.resume("view-a"))).toBe(true);
    expect(await run(tracker.getStatus("view-a"))).toBe("ACTIVE");
  });

  test("reset clears error count and re-activates a FAILED processor, without rewinding position", async () => {
    const { tracker, management } = await run(setup());
    await run(tracker.updateProgress("view-a", 42n));
    for (let i = 0; i < 10; i++) await run(tracker.recordError("view-a", "boom", 10));
    expect(await run(tracker.getStatus("view-a"))).toBe("FAILED");

    expect(await run(management.reset("view-a"))).toBe(true);
    expect(await run(tracker.getStatus("view-a"))).toBe("ACTIVE");
    expect(await run(tracker.getLastPosition("view-a"))).toBe(42n);
  });

  test("getAllStatuses reflects only known processorIds", async () => {
    const { management } = await run(setup());
    const statuses = await run(management.getAllStatuses);
    expect([...statuses.keys()].sort()).toEqual(["view-a", "view-b"]);
    expect(statuses.get("view-a")).toBe("ACTIVE");
  });
});
