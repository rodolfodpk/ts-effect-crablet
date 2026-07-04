// Runs under Node (not Bun) - see NOTES.md: @testcontainers/postgresql hangs indefinitely under
// Bun's wait-strategy handling, confirmed working under plain Node. Run via: node --test test/append.test.ts
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { Effect, Layer, Redacted } from "effect";
import { SqlClient } from "@effect/sql";
import { PgClient } from "@effect/sql-pg";
import { startTestDb, type TestDb } from "../src/testcontainer.ts";
import { appendEventsIf } from "../src/append.ts";
import { queryEvents } from "../src/project.ts";

let db: TestDb;
let layer: Layer.Layer<PgClient.PgClient | SqlClient.SqlClient, never>;

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

const run = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>) =>
  Effect.runPromise(Effect.provide(effect, layer) as Effect.Effect<A, E, never>);

describe("append_events_if parity (Phase 0, Risk A)", () => {
  it("successful append with no condition, event is queryable back", async () => {
    const correlationId = crypto.randomUUID();
    const result = await run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const appendResult = yield* appendEventsIf(sql, {
          events: [
            {
              type: "SpikeTestEvent",
              tags: [{ key: "spike_id", value: correlationId }],
              data: { hello: "world" }
            }
          ],
          occurredAt: new Date(),
          correlationId
        });
        const events = yield* queryEvents(sql, [
          { eventTypes: ["SpikeTestEvent"], tags: [{ key: "spike_id", value: correlationId }] }
        ]);
        return { appendResult, events };
      })
    );

    assert.strictEqual(result.appendResult.eventsCount, 1);
    assert.strictEqual(typeof result.appendResult.transactionId, "string");
    assert.strictEqual(result.events.length, 1);
    assert.strictEqual(result.events[0]?.type, "SpikeTestEvent");
    assert.deepStrictEqual(result.events[0]?.data, { hello: "world" });
    assert.ok(result.events[0]?.tags.includes(`spike_id=${correlationId}`));
  });

  it("tag round-trip preserves '=' and unicode in values", async () => {
    const spikeId = crypto.randomUUID();
    const trickyValue = "a=b_héllo_wörld";
    await run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* appendEventsIf(sql, {
          events: [
            {
              type: "SpikeTagRoundTrip",
              tags: [
                { key: "spike_id", value: spikeId },
                { key: "tricky", value: trickyValue }
              ],
              data: {}
            }
          ],
          occurredAt: new Date(),
          correlationId: crypto.randomUUID()
        });
      })
    );

    const events = await run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        return yield* queryEvents(sql, [
          { eventTypes: ["SpikeTagRoundTrip"], tags: [{ key: "spike_id", value: spikeId }] }
        ]);
      })
    );

    assert.strictEqual(events.length, 1);
    assert.ok(events[0]?.tags.includes(`tricky=${trickyValue}`));
  });

  it("concurrent double-append against same condition -> exactly one DCB_VIOLATION (20 runs)", async () => {
    for (let i = 0; i < 20; i++) {
      const marker = `dcb-race-${crypto.randomUUID()}`;
      const conditionTag = { key: "race_marker", value: marker };

      const attempt = () =>
        run(
          Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            return yield* appendEventsIf(sql, {
              events: [{ type: "RaceEvent", tags: [conditionTag], data: {} }],
              condition: { eventTypes: ["RaceEvent"], conditionTags: [conditionTag], afterCursorPosition: 0n },
              occurredAt: new Date(),
              correlationId: crypto.randomUUID()
            }).pipe(
              Effect.map(() => "success" as const),
              Effect.catchTag("DcbViolation", () => Effect.succeed("dcb_violation" as const))
            );
          })
        );

      const [a, b] = await Promise.all([attempt(), attempt()]);
      const outcomes = [a, b].sort();
      assert.deepStrictEqual(outcomes, ["dcb_violation", "success"]);
    }
  }, { timeout: 30_000 });

  it("concurrent idempotent duplicate -> exactly one IDEMPOTENCY_VIOLATION (20 runs)", async () => {
    for (let i = 0; i < 20; i++) {
      const idKey = `idem-race-${crypto.randomUUID()}`;

      const attempt = () =>
        run(
          Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            return yield* appendEventsIf(sql, {
              events: [{ type: "IdemRaceEvent", tags: [{ key: "idem_key", value: idKey }], data: {} }],
              idempotency: { types: ["IdemRaceEvent"], tags: [{ key: "idem_key", value: idKey }] },
              occurredAt: new Date(),
              correlationId: crypto.randomUUID()
            }).pipe(
              Effect.map(() => "success" as const),
              Effect.catchTag("IdempotencyViolation", () => Effect.succeed("idempotency_violation" as const))
            );
          })
        );

      const [a, b] = await Promise.all([attempt(), attempt()]);
      const outcomes = [a, b].sort();
      assert.deepStrictEqual(outcomes, ["idempotency_violation", "success"]);
    }
  }, { timeout: 30_000 });

  it("sequential idempotent duplicate -> second call fails", async () => {
    const idKey = `idem-seq-${crypto.randomUUID()}`;
    const call = () =>
      run(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          return yield* appendEventsIf(sql, {
            events: [{ type: "IdemSeqEvent", tags: [{ key: "idem_key", value: idKey }], data: {} }],
            idempotency: { types: ["IdemSeqEvent"], tags: [{ key: "idem_key", value: idKey }] },
            occurredAt: new Date(),
            correlationId: crypto.randomUUID()
          });
        })
      );

    await call();
    await assert.rejects(call());
  });
});
