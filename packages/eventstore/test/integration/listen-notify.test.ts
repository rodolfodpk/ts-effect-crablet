// Runs under Node (Testcontainers) - see NOTES.md.
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { Effect, Fiber, Layer, Queue, Redacted, Stream } from "effect";
import { SqlClient } from "effect/sql";
import { PgClient } from "@effect/sql-pg";
import { startTestDb, type TestDb } from "@crablet/test-support";
import { wakeupStream, type WakeupBatch } from "../../src/Listen.ts";
import { encodePayload } from "../../src/NotifyPayload.ts";

let db: TestDb;
let layer: Layer.Layer<PgClient.PgClient | SqlClient.SqlClient, never>;

const CHANNEL = "crablet_events_spike";

before(async () => {
  db = await startTestDb();
  layer = PgClient.layer({
    host: db.connInfo.host,
    port: db.connInfo.port,
    database: db.connInfo.database,
    username: db.connInfo.username,
    password: Redacted.make(db.connInfo.password)
  }) as unknown as Layer.Layer<PgClient.PgClient | SqlClient.SqlClient, never>;
}, { timeout: 60_000 });

after(async () => {
  await db.stop();
});

describe("LISTEN/NOTIFY parity (Phase 0, Risk B part 1)", () => {
  it("notify round-trip: a single notification is received and decoded", { timeout: 20_000 }, async () => {
    const result = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const pg = yield* PgClient.PgClient;
          const queue = yield* Queue.unbounded<WakeupBatch>();

          const fiber = yield* Stream.runForEach(wakeupStream(pg, CHANNEL), (batch) =>
            Queue.offer(queue, batch)
          ).pipe(Effect.forkChild);

          // Give the dedicated LISTEN connection a moment to register LISTEN before notifying.
          yield* Effect.sleep("200 millis");

          const payload = encodePayload(new Set(["SpikeNotifyEvent"]), new Set(["spike_id"]));
          yield* pg.notify(CHANNEL, payload);

          const batch = yield* Queue.take(queue).pipe(Effect.timeout("5 seconds"));
          yield* Fiber.interrupt(fiber);
          return batch;
        }),
        layer
      )
    );

    assert.ok(result !== undefined && result !== null);
    assert.strictEqual((result as WakeupBatch).wildcard, false);
    assert.deepStrictEqual([...(result as WakeupBatch).types], ["SpikeNotifyEvent"]);
    assert.deepStrictEqual([...(result as WakeupBatch).tagKeys], ["spike_id"]);
  });

  it("a burst of rapid notifications coalesces into one wakeup with the union of types/tag-keys", { timeout: 20_000 }, async () => {
    const result = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const pg = yield* PgClient.PgClient;
          const queue = yield* Queue.unbounded<WakeupBatch>();

          const fiber = yield* Stream.runForEach(wakeupStream(pg, CHANNEL), (batch) =>
            Queue.offer(queue, batch)
          ).pipe(Effect.forkChild);

          yield* Effect.sleep("200 millis");

          // Fire 5 notifications in rapid succession (well within the 20ms debounce window).
          yield* Effect.all(
            [
              pg.notify(CHANNEL, encodePayload(new Set(["EventA"]), new Set(["tag_a"]))),
              pg.notify(CHANNEL, encodePayload(new Set(["EventB"]), new Set(["tag_b"]))),
              pg.notify(CHANNEL, encodePayload(new Set(["EventC"]), new Set())),
              pg.notify(CHANNEL, encodePayload(new Set(["EventA"]), new Set(["tag_a", "tag_c"]))),
              pg.notify(CHANNEL, encodePayload(new Set(["EventD"]), new Set(["tag_d"])))
            ],
            { concurrency: "unbounded" }
          );

          // Drain whatever arrives within a window a bit longer than the 20ms debounce.
          yield* Effect.sleep("300 millis");
          const drained = yield* Queue.takeAll(queue);
          yield* Fiber.interrupt(fiber);
          return drained;
        }),
        layer
      )
    );

    const batches = result as ReadonlyArray<WakeupBatch>;
    // The core claim under test: coalesced into few dispatches, not one-per-notification (5).
    assert.ok(batches.length < 5, `expected coalescing, got ${batches.length} separate dispatches`);

    const allTypes = new Set<string>();
    const allTagKeys = new Set<string>();
    for (const b of batches) {
      for (const t of b.types) allTypes.add(t);
      for (const k of b.tagKeys) allTagKeys.add(k);
    }
    assert.deepStrictEqual([...allTypes].sort(), ["EventA", "EventB", "EventC", "EventD"]);
    assert.deepStrictEqual([...allTagKeys].sort(), ["tag_a", "tag_b", "tag_c", "tag_d"]);
  });

  it("when the LISTEN session is terminated the stream reconnects, announces a wildcard, and delivers again", { timeout: 30_000 }, async () => {
    const channel = "crablet_events_reconnect";
    const got = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const pg = yield* PgClient.PgClient;
          const sql = yield* SqlClient.SqlClient;
          const queue = yield* Queue.unbounded<WakeupBatch>();
          const fiber = yield* Stream.runForEach(wakeupStream(pg, channel, { retryBase: "100 millis" }), (b) => Queue.offer(queue, b)).pipe(Effect.forkChild);
          yield* Effect.sleep("300 millis");
          const victims = yield* sql.unsafe<{ pid: number }>(`SELECT pid FROM pg_stat_activity WHERE datname = current_database() AND query LIKE 'LISTEN%${channel}%' AND pid <> pg_backend_pid()`);
          for (const v of victims) yield* sql.unsafe("SELECT pg_terminate_backend($1)", [v.pid]);
          const wildcard = yield* Queue.take(queue).pipe(Effect.timeout("10 seconds"));
          yield* pg.notify(channel, encodePayload(new Set(["AfterReconnect"]), new Set()));
          const batch = yield* Queue.take(queue).pipe(Effect.timeout("5 seconds"));
          yield* Fiber.interrupt(fiber);
          return { killed: victims.length, wildcard: wildcard.wildcard, types: [...batch.types] };
        }),
        layer
      )
    );
    assert.strictEqual(got.killed, 1);
    assert.strictEqual(got.wildcard, true);
    assert.deepStrictEqual(got.types, ["AfterReconnect"]);
  });
});
