// Runs under Node (not Bun) - see NOTES.md: @testcontainers/postgresql hangs indefinitely under
// Bun's wait-strategy handling, confirmed working under plain Node. Run via: node --test
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { Effect, Fiber, Layer, Queue, Redacted, Stream } from "effect";
import { SqlClient } from "@effect/sql";
import { PgClient } from "@effect/sql-pg";
import { startTestDb, type TestDb } from "@crablet/test-support";
import { EventStore, EventStoreLive, EVENTS_CHANNEL, existsProjector } from "../src/EventStore.ts";
import { CommandAuditStore, CommandAuditStoreLive } from "../src/CommandAuditStore.ts";
import * as AppendEvent from "../src/AppendEvent.ts";
import * as Query from "../src/Query.ts";
import * as StreamPosition from "../src/StreamPosition.ts";
import { ConcurrencyException } from "../src/DCBViolation.ts";
import { wakeupStream, type WakeupBatch } from "../src/Listen.ts";

let db: TestDb;
let layer: Layer.Layer<EventStore | CommandAuditStore | SqlClient.SqlClient, never>;

before(async () => {
  db = await startTestDb();
  const pgLayer = PgClient.layer({
    host: db.connInfo.host,
    port: db.connInfo.port,
    database: db.connInfo.database,
    username: db.connInfo.username,
    password: Redacted.make(db.connInfo.password)
  });
  // provideMerge (not provide) so SqlClient itself stays in the output - needed by the
  // transaction_id test, which uses sql.withTransaction directly.
  layer = Layer.provideMerge(Layer.merge(EventStoreLive, CommandAuditStoreLive), pgLayer) as unknown as Layer.Layer<
    EventStore | CommandAuditStore | SqlClient.SqlClient,
    never
  >;
}, { timeout: 60_000 });

after(async () => {
  await db.stop();
});

const run = <A, E>(effect: Effect.Effect<A, E, EventStore | CommandAuditStore | SqlClient.SqlClient>) =>
  Effect.runPromise(Effect.provide(effect, layer) as Effect.Effect<A, E, never>);

describe("EventStore public API parity (Phase 1)", () => {
  it("appendCommutative: event is queryable back", async () => {
    const spikeId = crypto.randomUUID();
    const result = await run(
      Effect.gen(function* () {
        const store = yield* EventStore;
        const transactionId = yield* store.appendCommutative([
          AppendEvent.of("SpikeTestEvent", "spike_id", spikeId, { hello: "world" })
        ]);
        const projection = yield* store.project(
          Query.forEventAndTag("SpikeTestEvent", "spike_id", spikeId),
          StreamPosition.zero(),
          [existsProjector()]
        );
        return { transactionId, exists: projection.state };
      })
    );

    assert.strictEqual(typeof result.transactionId, "string");
    assert.strictEqual(result.exists, true);
  });

  it("tag round-trip preserves '=' and unicode in values", async () => {
    const spikeId = crypto.randomUUID();
    const trickyValue = "a=b_héllo_wörld";

    await run(
      Effect.gen(function* () {
        const store = yield* EventStore;
        yield* store.appendCommutative([
          AppendEvent.builder("SpikeTagRoundTrip")
            .tag("spike_id", spikeId)
            .tag("tricky", trickyValue)
            .data({})
            .build()
        ]);
      })
    );

    const found = await run(
      Effect.gen(function* () {
        const store = yield* EventStore;
        const projection = yield* store.project(
          Query.forEventAndTag("SpikeTagRoundTrip", "spike_id", spikeId),
          StreamPosition.zero(),
          [existsProjector()]
        );
        return projection.state;
      })
    );
    assert.strictEqual(found, true);
  });

  it("concurrent double appendNonCommutative against same condition -> exactly one DCB_VIOLATION (20 runs)", { timeout: 30_000 }, async () => {
    for (let i = 0; i < 20; i++) {
      const marker = `dcb-race-${crypto.randomUUID()}`;
      const decisionModel = Query.forEventAndTag("RaceEvent", "race_marker", marker);

      const attempt = () =>
        run(
          Effect.gen(function* () {
            const store = yield* EventStore;
            return yield* store
              .appendNonCommutative(
                [AppendEvent.of("RaceEvent", "race_marker", marker, {})],
                decisionModel,
                StreamPosition.zero()
              )
              .pipe(
                Effect.map(() => "success" as const),
                Effect.catchTag("ConcurrencyException", (e) =>
                  Effect.succeed(e.violation?.errorCode === "DCB_VIOLATION" ? "dcb_violation" as const : "other" as const)
                )
              );
          })
        );

      const [a, b] = await Promise.all([attempt(), attempt()]);
      const outcomes = [a, b].sort();
      assert.deepStrictEqual(outcomes, ["dcb_violation", "success"]);
    }
  });

  it("concurrent idempotent duplicate -> exactly one IDEMPOTENCY_VIOLATION (20 runs)", { timeout: 30_000 }, async () => {
    for (let i = 0; i < 20; i++) {
      const idKey = `idem-race-${crypto.randomUUID()}`;

      const attempt = () =>
        run(
          Effect.gen(function* () {
            const store = yield* EventStore;
            return yield* store
              .appendIdempotent([AppendEvent.of("IdemRaceEvent", "idem_key", idKey, {})], "IdemRaceEvent", "idem_key", idKey)
              .pipe(
                Effect.map(() => "success" as const),
                Effect.catchTag("ConcurrencyException", (e) =>
                  Effect.succeed(
                    e.violation?.errorCode === "IDEMPOTENCY_VIOLATION" ? "idempotency_violation" as const : "other" as const
                  )
                )
              );
          })
        );

      const [a, b] = await Promise.all([attempt(), attempt()]);
      const outcomes = [a, b].sort();
      assert.deepStrictEqual(outcomes, ["idempotency_violation", "success"]);
    }
  });

  it("sequential idempotent duplicate -> second call fails with ConcurrencyException", async () => {
    const idKey = `idem-seq-${crypto.randomUUID()}`;
    // Effect.runPromise rejects with a FiberFailure wrapper, not the raw tagged error, so
    // assert.rejects(promise, ConcurrencyException) can't match by constructor. Catch the
    // expected failure inside the Effect pipeline instead and assert on a plain return value.
    const call = () =>
      run(
        Effect.gen(function* () {
          const store = yield* EventStore;
          return yield* store.appendIdempotent(
            [AppendEvent.of("IdemSeqEvent", "idem_key", idKey, {})],
            "IdemSeqEvent",
            "idem_key",
            idKey
          );
        })
      );
    const callExpectingViolation = () =>
      run(
        Effect.gen(function* () {
          const store = yield* EventStore;
          return yield* store
            .appendIdempotent(
              [AppendEvent.of("IdemSeqEvent", "idem_key", idKey, {})],
              "IdemSeqEvent",
              "idem_key",
              idKey
            )
            .pipe(
              Effect.map(() => "success" as const),
              Effect.catchTag("ConcurrencyException", (e) => Effect.succeed(e))
            );
        })
      );

    await call();
    const second = await callExpectingViolation();
    assert.ok(second instanceof ConcurrencyException, `expected ConcurrencyException, got ${JSON.stringify(second)}`);
    assert.strictEqual(second.violation?.errorCode, "IDEMPOTENCY_VIOLATION");
  });

  it("transaction_id audit-linkage invariant: command and event share the same transaction_id", async () => {
    const commandId = crypto.randomUUID();
    const spikeId = crypto.randomUUID();

    const result = await run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        return yield* sql.withTransaction(
          Effect.gen(function* () {
            const store = yield* EventStore;
            const auditStore = yield* CommandAuditStore;

            const inserted = yield* auditStore.storeCommandIfAbsent(
              JSON.stringify({ spikeId }),
              "SpikeCommand",
              commandId,
              new Date()
            );
            const eventTransactionId = yield* store.appendCommutative([
              AppendEvent.of("SpikeAuditEvent", "spike_id", spikeId, {})
            ]);

            const rows = yield* sql.unsafe<{ transaction_id: string }>(
              "SELECT transaction_id::text FROM crablet_commands WHERE command_id = $1::uuid",
              [commandId]
            );

            return { inserted, eventTransactionId, commandTransactionId: rows[0]?.transaction_id };
          })
        );
      })
    );

    assert.strictEqual(result.inserted, true);
    assert.strictEqual(typeof result.commandTransactionId, "string");
    // The whole point of the invariant: both writes happened in the same DB transaction, so they
    // share the same pg_current_xact_id() - this is the join key CommandExecutor's audit linkage
    // relies on (see spring-crablet's closed design decision: no command_id column on events).
    assert.strictEqual(result.commandTransactionId, result.eventTransactionId);
  });

  it("appendCommutative fires a NOTIFY on EVENTS_CHANNEL (Phase 3 NOTIFY-wiring fix)", { timeout: 20_000 }, async () => {
    const spikeId = crypto.randomUUID();

    const runWithPg = <A, E>(
      effect: Effect.Effect<A, E, EventStore | SqlClient.SqlClient | PgClient.PgClient>
    ) => Effect.runPromise(Effect.provide(effect, layer) as Effect.Effect<A, E, never>);

    const batch = await runWithPg(
      Effect.gen(function* () {
        const pg = yield* PgClient.PgClient;
        const queue = yield* Queue.unbounded<WakeupBatch>();
        const fiber = yield* Stream.runForEach(wakeupStream(pg, EVENTS_CHANNEL), (b) =>
          Queue.offer(queue, b)
        ).pipe(Effect.fork);

        // Give the dedicated LISTEN connection a moment to register before appending.
        yield* Effect.sleep("200 millis");

        const store = yield* EventStore;
        yield* store.appendCommutative([
          AppendEvent.of("SpikeNotifyWiringEvent", "spike_id", spikeId, {})
        ]);

        const received = yield* Queue.take(queue).pipe(Effect.timeout("5 seconds"));
        yield* Fiber.interrupt(fiber);
        return received;
      })
    );

    assert.ok(batch !== undefined && batch !== null, "expected a NOTIFY to be received");
    assert.strictEqual((batch as WakeupBatch).wildcard, false);
    assert.ok((batch as WakeupBatch).types.has("SpikeNotifyWiringEvent"));
  });
});
