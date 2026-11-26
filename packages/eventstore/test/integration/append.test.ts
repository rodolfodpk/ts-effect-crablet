// Runs under Node (not Bun) - see docs/history/NOTES.md: @testcontainers/postgresql hangs indefinitely under
// Bun's wait-strategy handling, confirmed working under plain Node. Run via: node --test
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { Cause, Effect, Exit, Fiber, Layer, Queue, Redacted, Stream } from "effect";
import { SqlClient } from "effect/sql";
import { PgClient } from "@effect/sql-pg";
import { startTestDb, type TestDb } from "@crablet/test-support";
import { EventStore, EventStoreLive, EVENTS_CHANNEL, existsProjector, makeEventStoreLayer, readToDecide } from "../../src/EventStore.ts";
import * as AppendEvent from "../../src/AppendEvent.ts";
import * as Query from "../../src/Query.ts";
import * as LogPosition from "../../src/LogPosition.ts";
import { Duplicate, MAX_APPEND_EVENTS } from "../../src/AppendErrors.ts";
import * as AppendCondition from "../../src/AppendCondition.ts";
import { wakeupStream, type WakeupBatch } from "../../src/Listen.ts";
import { type ProcessConnections, ProcessConnectionsLive } from "../../src/ProcessConnections.ts";

let db: TestDb;
let layer: Layer.Layer<EventStore | SqlClient.SqlClient | PgClient.PgClient | ProcessConnections, never>;

before(async () => {
  db = await startTestDb();
  const pgLayer = PgClient.layer({
    host: db.connInfo.host,
    port: db.connInfo.port,
    database: db.connInfo.database,
    username: db.connInfo.username,
    password: Redacted.make(db.connInfo.password)
  });
  // provideMerge (not provide) so SqlClient itself stays in the output, for the tests that use it directly.
  layer = Layer.provideMerge(Layer.merge(EventStoreLive, ProcessConnectionsLive), pgLayer).pipe(Layer.orDie);
}, { timeout: 60_000 });

after(async () => {
  await db.stop();
});

const run = <A, E>(effect: Effect.Effect<A, E, EventStore | SqlClient.SqlClient>) =>
  Effect.runPromise(Effect.provide(effect, layer));

describe("EventStore public API parity (Phase 1)", () => {
  it("append: event is queryable back", async () => {
    const spikeId = crypto.randomUUID();
    const result = await run(
      Effect.gen(function* () {
        const store = yield* EventStore;
        const { transactionId } = yield* store.append([
          AppendEvent.of("SpikeTestEvent", "spike_id", spikeId, { hello: "world" })
        ]);
        const projection = yield* store.project(
          Query.forEventAndTag("SpikeTestEvent", "spike_id", spikeId),
          LogPosition.zero(),
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
        yield* store.append([
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
          LogPosition.zero(),
          [existsProjector()]
        );
        return projection.state;
      })
    );
    assert.strictEqual(found, true);
  });

  it("concurrent double conditional append against same condition -> exactly one Conflict (20 runs)", { timeout: 30_000 }, async () => {
    for (let i = 0; i < 20; i++) {
      const marker = `dcb-race-${crypto.randomUUID()}`;
      const decisionModel = Query.forEventAndTag("RaceEvent", "race_marker", marker);

      const attempt = () =>
        run(
          Effect.gen(function* () {
            const store = yield* EventStore;
            return yield* store
              .append(
                [AppendEvent.of("RaceEvent", "race_marker", marker, {})],
                AppendCondition.of(LogPosition.zero(), decisionModel)
              )
              .pipe(
                Effect.map(() => "success" as const),
                Effect.catchTag("Conflict", () => Effect.succeed("conflict" as const))
              );
          })
        );

      const [a, b] = await Promise.all([attempt(), attempt()]);
      const outcomes = [a, b].sort();
      assert.deepStrictEqual(outcomes, ["conflict", "success"]);
    }
  });

  it("concurrent idempotent duplicate -> exactly one Duplicate (20 runs)", { timeout: 30_000 }, async () => {
    for (let i = 0; i < 20; i++) {
      const idKey = `idem-race-${crypto.randomUUID()}`;

      const attempt = () =>
        run(
          Effect.gen(function* () {
            const store = yield* EventStore;
            return yield* store
              .append(
                [AppendEvent.of("IdemRaceEvent", "idem_key", idKey, {})],
                AppendCondition.idempotent("IdemRaceEvent", "idem_key", idKey)
              )
              .pipe(
                Effect.map(() => "success" as const),
                Effect.catchTag("Duplicate", () => Effect.succeed("duplicate" as const))
              );
          })
        );

      const [a, b] = await Promise.all([attempt(), attempt()]);
      const outcomes = [a, b].sort();
      assert.deepStrictEqual(outcomes, ["duplicate", "success"]);
    }
  });

  it("sequential idempotent duplicate -> second call fails with Duplicate", async () => {
    const idKey = `idem-seq-${crypto.randomUUID()}`;
    // Effect.runPromise rejects with a FiberFailure wrapper, not the raw tagged error, so
    // assert.rejects(promise, Duplicate) can't match by constructor. Catch the expected failure
    // inside the Effect pipeline instead and assert on a plain return value.
    const call = () =>
      run(
        Effect.gen(function* () {
          const store = yield* EventStore;
          return yield* store.append(
            [AppendEvent.of("IdemSeqEvent", "idem_key", idKey, {})],
            AppendCondition.idempotent("IdemSeqEvent", "idem_key", idKey)
          );
        })
      );
    const callExpectingDuplicate = () =>
      run(
        Effect.gen(function* () {
          const store = yield* EventStore;
          return yield* store
            .append(
              [AppendEvent.of("IdemSeqEvent", "idem_key", idKey, {})],
              AppendCondition.idempotent("IdemSeqEvent", "idem_key", idKey)
            )
            .pipe(
              Effect.map(() => "success" as const),
              Effect.catchTag("Duplicate", (e) => Effect.succeed(e))
            );
        })
      );

    const first = await call();
    const second = await callExpectingDuplicate();
    assert.ok(second instanceof Duplicate, `expected Duplicate, got ${String(second)}`);
    // It says what it matched (ADR-0034): the earlier event, and the request behind it (a raw append stores no fingerprint and has no cause).
    assert.deepStrictEqual(second.latest, { position: first.lastPosition, transactionId: first.transactionId });
    assert.deepStrictEqual(second.requests, [{ fingerprint: null, causationId: null }]);
  });

  it("append fires a NOTIFY on EVENTS_CHANNEL (Phase 3 NOTIFY-wiring fix)", { timeout: 20_000 }, async () => {
    const spikeId = crypto.randomUUID();

    const runWithPg = <A, E>(
      effect: Effect.Effect<A, E, EventStore | SqlClient.SqlClient | PgClient.PgClient | ProcessConnections>
    ) => Effect.runPromise(Effect.provide(effect, layer));

    const batch = await runWithPg(
      Effect.gen(function* () {
        const pg = yield* PgClient.PgClient;
        const queue = yield* Queue.unbounded<WakeupBatch>();
        const fiber = yield* Stream.runForEach(wakeupStream(pg, EVENTS_CHANNEL), (b) =>
          Queue.offer(queue, b)
        ).pipe(Effect.forkChild);

        // Give the dedicated LISTEN connection a moment to register before appending.
        yield* Effect.sleep("200 millis");

        const store = yield* EventStore;
        yield* store.append([
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

describe("append size limit", () => {
  it("refuses more than MAX_APPEND_EVENTS with AppendTooLarge before any SQL runs, and accepts exactly the limit", async () => {
    const batch = (n: number) => Array.from({ length: n }, (_, i) => AppendEvent.of("SizeLimitEvent", "batch", `b${i}`, {}));
    const error = await run(Effect.flatMap(EventStore, (store) => Effect.flip(store.append(batch(MAX_APPEND_EVENTS + 1)))));
    assert.strictEqual(error._tag, "AppendTooLarge");
    const ok = await run(Effect.flatMap(EventStore, (store) => store.append(batch(MAX_APPEND_EVENTS))));
    assert.strictEqual(typeof ok.transactionId, "string");
  });
});

describe("maxAppendEvents (ADR-0049)", () => {
  it("sets the limit of one append: 3 pass, 4 are refused with AppendTooLarge carrying the limit", async () => {
    const pg = PgClient.layer({ host: db.connInfo.host, port: db.connInfo.port, database: db.connInfo.database, username: db.connInfo.username, password: Redacted.make(db.connInfo.password) });
    const small = Layer.provide(makeEventStoreLayer({ maxAppendEvents: 3 }), pg).pipe(Layer.orDie);
    const batch = (n: number) => Array.from({ length: n }, (_, i) => AppendEvent.of("SmallLimitEvent", "batch", `b${i}`, {}));
    const go = <A, E>(effect: Effect.Effect<A, E, EventStore>) => Effect.runPromise(Effect.provide(effect, small));
    await go(Effect.flatMap(EventStore, (store) => store.append(batch(3))));
    const error = await go(Effect.flatMap(EventStore, (store) => Effect.flip(store.append(batch(4)))));
    assert.deepStrictEqual({ tag: error._tag, max: (error as { max?: number }).max }, { tag: "AppendTooLarge", max: 3 });
  });
});

describe("AppendCondition.firstWrite (ADR-0049)", () => {
  const isCrb01Defect = (exit: Exit.Exit<unknown, unknown>) =>
    Exit.isFailure(exit) && exit.cause.reasons.some((r) => Cause.isDieReason(r) && /already written|CRB01/.test(String(r.defect)));
  const conditionOn = (id: string) => AppendCondition.of(LogPosition.zero(), Query.forEventAndTag("FirstWriteOther", "fw", id));

  it("an append that asks for it, after a write in the same transaction, is refused (CRB01) and nothing is stored", async () => {
    const id = crypto.randomUUID();
    const exit = await run(
      Effect.exit(
        Effect.flatMap(SqlClient.SqlClient, (sql) =>
          sql.withTransaction(
            Effect.flatMap(EventStore, (store) =>
              Effect.andThen(store.append([AppendEvent.of("FirstWriteX", "fw", id, {})]), store.append([AppendEvent.of("FirstWriteY", "fw", id, {})], AppendCondition.firstWrite(conditionOn(id))))
            )
          )
        )
      )
    );
    assert.ok(isCrb01Defect(exit), `expected the CRB01 defect, got ${String(exit)}`);
    const stored = await run(Effect.flatMap(EventStore, (store) => store.exists(Query.of(Query.queryItemOf([], [{ key: "fw", value: id }])))));
    assert.strictEqual(stored, false, "the transaction rolled back");
  });

  it("without it, the same flow passes: a transaction's own earlier appends are not refused for it (the documented exception)", async () => {
    const id = crypto.randomUUID();
    await run(
      Effect.flatMap(SqlClient.SqlClient, (sql) =>
        sql.withTransaction(
          Effect.flatMap(EventStore, (store) =>
            Effect.andThen(store.append([AppendEvent.of("FirstWriteX", "fw", id, {})]), store.append([AppendEvent.of("FirstWriteY", "fw", id, {})], conditionOn(id)))
          )
        )
      )
    );
  });

  it("an append that asks for it and is its transaction's first write passes", async () => {
    const id = crypto.randomUUID();
    const result = await run(
      Effect.flatMap(SqlClient.SqlClient, (sql) =>
        sql.withTransaction(Effect.flatMap(EventStore, (store) => store.append([AppendEvent.of("FirstWriteY", "fw", id, {})], AppendCondition.firstWrite(conditionOn(id)))))
      )
    );
    assert.strictEqual(typeof result.transactionId, "string");
  });

  it("decision.append passes it on (ADR-0052): after a write in the same transaction, refused (CRB01)", async () => {
    const id = crypto.randomUUID();
    const exit = await run(
      Effect.exit(
        Effect.flatMap(SqlClient.SqlClient, (sql) =>
          sql.withTransaction(
            Effect.gen(function* () {
              const store = yield* EventStore;
              const decision = yield* readToDecide(Query.match("FirstWriteOther", { fw: id }));
              yield* store.append([AppendEvent.of("FirstWriteX", "fw", id, {})]);
              return yield* decision.append([AppendEvent.of("FirstWriteY", "fw", id, {})], { firstWrite: true });
            })
          )
        )
      )
    );
    assert.ok(isCrb01Defect(exit), `expected the CRB01 defect, got ${String(exit)}`);
  });
});
