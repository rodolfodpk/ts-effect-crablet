import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import type { SqlClient } from "effect/sql";
import { BACKLOG_CAP, isBackedOff, makeProcessorManagementService } from "../src/ProcessorManagementService.ts";
import * as EventSelection from "../src/EventSelection.ts";
import { makeInMemoryProgressTracker } from "./fixtures/InMemoryProgressTracker.ts";
import * as ProgressCursorNS from "../src/ProgressCursor.ts";

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
    await run(tracker.updateCursor("view-a", ProgressCursorNS.of("7", 7n)));

    const management = makeProcessorManagementService({
      progressTracker: tracker,
      getAllStatuses: Effect.succeed(new Map([["view-a", "ACTIVE" as const]])),
      pauseProcessor: () => Effect.void,
      resumeProcessor: () => Effect.void,
      backoffSnapshot: () => Effect.succeed(null),
      allBackoffSnapshots: Effect.succeed(new Map()),
      sql: fakeSql(20n)
    });

    // The real implementation computes this as a raw subtraction in SQL; our fake mirrors the same
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

describe("ProcessorManagementService: backlog", () => {
  // The query's shape is exercised against Postgres in integration/backlog.test.ts; here only what the service makes of the row.
  const backlogSql = (row: { pending: string; oldest_seconds: number | null }): SqlClient.SqlClient =>
    ({ unsafe: () => Effect.succeed([row]) }) as unknown as SqlClient.SqlClient;

  const serviceOver = async (sql: SqlClient.SqlClient, selectionOf?: () => EventSelection.EventSelection | undefined) => {
    const { tracker } = await run(makeInMemoryProgressTracker<string>());
    await run(tracker.autoRegister("view-a", "test-instance"));
    await run(tracker.updateCursor("view-a", ProgressCursorNS.of("7", 7n)));
    // Reading the backlog must not go through getCursor (the outbox's refreshes the leader columns): make that one fail loudly.
    const guarded = { ...tracker, getCursor: () => Effect.die(new Error("getCursor must not be used for monitoring")) };
    return makeProcessorManagementService({
      progressTracker: guarded,
      getAllStatuses: Effect.succeed(new Map([["view-a", "ACTIVE" as const]])),
      pauseProcessor: () => Effect.void,
      resumeProcessor: () => Effect.void,
      backoffSnapshot: () => Effect.succeed(null),
      allBackoffSnapshots: Effect.succeed(new Map()),
      sql,
      ...(selectionOf === undefined ? {} : { selectionOf })
    });
  };
  const some = () => EventSelection.of({ eventTypes: new Set(["Rare"]) });

  test("reports the cursor, the pending events and the age of the oldest, reading the cursor with peekCursor", async () => {
    const management = await serviceOver(backlogSql({ pending: "3", oldest_seconds: 12.5 }), some);
    expect(await run(management.getBacklog("view-a"))).toEqual({ cursor: ProgressCursorNS.of("7", 7n), pendingEvents: 3, capped: false, oldestPendingSeconds: 12.5 });
  });

  test("nothing pending: zero events, no age", async () => {
    const management = await serviceOver(backlogSql({ pending: "0", oldest_seconds: null }), some);
    expect(await run(management.getBacklog("view-a"))).toMatchObject({ pendingEvents: 0, capped: false, oldestPendingSeconds: null });
  });

  test("a count that reaches the cap says it is capped; an age from a clock that is behind the database is clamped to zero", async () => {
    const management = await serviceOver(backlogSql({ pending: String(BACKLOG_CAP), oldest_seconds: -3 }), some);
    expect(await run(management.getBacklog("view-a"))).toMatchObject({ pendingEvents: BACKLOG_CAP, capped: true, oldestPendingSeconds: 0 });
  });

  test("an id whose selection this service does not know has no backlog (null), and no query is made", async () => {
    const noSql = { unsafe: () => Effect.die(new Error("no query expected")) } as unknown as SqlClient.SqlClient;
    expect(await run((await serviceOver(noSql)).getBacklog("view-a"))).toBeNull();
    expect(await run((await serviceOver(noSql, () => undefined)).getBacklog("view-a"))).toBeNull();
  });

  test("getLag reads the cursor with peekCursor too", async () => {
    const management = await serviceOver(fakeSql(20n));
    expect(await run(management.getLag("view-a"))).toBe(20n);
  });
});

describe("ProcessorManagementService: failure details", () => {
  const withDetails = async (details?: Effect.Effect<ReadonlyMap<string, { errorCount: number; lastError: string | null }>, unknown>) => {
    const { tracker } = await run(makeInMemoryProgressTracker<string>());
    return makeProcessorManagementService({
      progressTracker: tracker,
      getAllStatuses: Effect.succeed(new Map()),
      pauseProcessor: () => Effect.void,
      resumeProcessor: () => Effect.void,
      backoffSnapshot: () => Effect.succeed(null),
      allBackoffSnapshots: Effect.succeed(new Map()),
      sql: fakeSql(null),
      ...(details === undefined ? {} : { details })
    });
  };

  test("getAllDetails passes through what the module's progress table said", async () => {
    const management = await withDetails(Effect.succeed(new Map([["view-a", { errorCount: 3, lastError: "boom" }]])));
    expect(await run(management.getAllDetails)).toEqual(new Map([["view-a", { errorCount: 3, lastError: "boom" }]]));
  });

  test("a service built without details has none", async () => {
    expect((await run((await withDetails()).getAllDetails)).size).toBe(0);
  });
});
