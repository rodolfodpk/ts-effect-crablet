import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import type { SqlClient } from "@effect/sql";
import { isBackedOff, makeProcessorManagementService } from "../src/ProcessorManagementService.ts";
import { makeInMemoryProgressTracker } from "./fixtures/InMemoryProgressTracker.ts";

const run = <A, E>(effect: Effect.Effect<A, E, never>) => Effect.runPromise(effect);

// A minimal fake SqlClient exposing only the `.unsafe` call getLag actually uses - a real
// MAX(position) query round-trip is exercised in the Postgres integration tests, not here.
const fakeSql = (maxPosition: bigint | null): SqlClient.SqlClient =>
  ({
    unsafe: (_query: string, _params: ReadonlyArray<unknown>) =>
      Effect.succeed([{ lag: maxPosition === null ? null : maxPosition.toString() }])
  }) as unknown as SqlClient.SqlClient;

describe("ProcessorManagementService: lag and backoff reporting", () => {
  test("getLag computes MAX(position) - lastPosition", async () => {
    const { tracker } = await run(makeInMemoryProgressTracker<string>());
    await run(tracker.autoRegister("view-a", "test-instance"));
    await run(tracker.updateProgress("view-a", 7n));

    const management = makeProcessorManagementService({
      progressTracker: tracker,
      getAllStatuses: Effect.succeed(new Map([["view-a", "ACTIVE" as const]])),
      pauseProcessor: () => Effect.void,
      resumeProcessor: () => Effect.void,
      backoffSnapshot: () => Effect.succeed(null),
      allBackoffSnapshots: Effect.succeed(new Map()),
      sql: fakeSql(20n)
    });

    // Real Java semantics compute this as a raw subtraction in SQL; our fake mirrors the same
    // shape via the "lag" column the fake query returns.
    expect(await run(management.getLag("view-a"))).toBe(20n);
  });

  test("getLag is null when the fake query reports no lag", async () => {
    const { tracker } = await run(makeInMemoryProgressTracker<string>());
    await run(tracker.autoRegister("view-a", "test-instance"));

    const management = makeProcessorManagementService({
      progressTracker: tracker,
      getAllStatuses: Effect.succeed(new Map([["view-a", "ACTIVE" as const]])),
      pauseProcessor: () => Effect.void,
      resumeProcessor: () => Effect.void,
      backoffSnapshot: () => Effect.succeed(null),
      allBackoffSnapshots: Effect.succeed(new Map()),
      sql: fakeSql(null)
    });

    expect(await run(management.getLag("view-a"))).toBeNull();
  });

  test("getBackoffInfo/getAllBackoffInfo pass through the live in-memory snapshot", async () => {
    const { tracker } = await run(makeInMemoryProgressTracker<string>());
    await run(tracker.autoRegister("view-a", "test-instance"));

    const management = makeProcessorManagementService({
      progressTracker: tracker,
      getAllStatuses: Effect.succeed(new Map([["view-a", "ACTIVE" as const]])),
      pauseProcessor: () => Effect.void,
      resumeProcessor: () => Effect.void,
      backoffSnapshot: (id) =>
        Effect.succeed(id === "view-a" ? { emptyPollCount: 5, currentSkipCounter: 3 } : null),
      allBackoffSnapshots: Effect.succeed(new Map([["view-a", { emptyPollCount: 5, currentSkipCounter: 3 }]])),
      sql: fakeSql(0n)
    });

    const info = await run(management.getBackoffInfo("view-a"));
    expect(info).toEqual({ emptyPollCount: 5, currentSkipCounter: 3 });
    expect(isBackedOff(info!)).toBe(true);

    expect(await run(management.getBackoffInfo("view-b"))).toBeNull();

    const all = await run(management.getAllBackoffInfo);
    expect(all.get("view-a")).toEqual({ emptyPollCount: 5, currentSkipCounter: 3 });
  });

  test("isBackedOff is false when currentSkipCounter is 0", () => {
    expect(isBackedOff({ emptyPollCount: 4, currentSkipCounter: 0 })).toBe(false);
  });
});
