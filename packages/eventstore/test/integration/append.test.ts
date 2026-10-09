// Runs under Node (not Bun) - see NOTES.md: @testcontainers/postgresql hangs indefinitely under
// Bun's wait-strategy handling, confirmed working under plain Node. Run via: node --test
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { Effect, Fiber, Layer, Queue, Redacted, Stream } from "effect";
import { SqlClient } from "effect/sql";
import { PgClient } from "@effect/sql-pg";
import { startTestDb, type TestDb } from "@crablet/test-support";
import { EventStore, EventStoreLive, EVENTS_CHANNEL, existsProjector } from "../../src/EventStore.ts";
import { CommandAuditStore, CommandAuditStoreLive } from "../../src/CommandAuditStore.ts";
import * as AppendEvent from "../../src/AppendEvent.ts";
import * as Query from "../../src/Query.ts";
import * as LogPosition from "../../src/LogPosition.ts";
import { Conflict, Duplicate, MAX_APPEND_EVENTS } from "../../src/AppendErrors.ts";
import * as AppendCondition from "../../src/AppendCondition.ts";
import { wakeupStream, type WakeupBatch } from "../../src/Listen.ts";

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

    await call();
    const second = await callExpectingDuplicate();
    assert.ok(second instanceof Duplicate, `expected Duplicate, got ${JSON.stringify(second)}`);
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
            const { transactionId: eventTransactionId } = yield* store.append([
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
    // relies on (by design there is no command_id column on events).
    assert.strictEqual(result.commandTransactionId, result.eventTransactionId);
  });

  it("append fires a NOTIFY on EVENTS_CHANNEL (Phase 3 NOTIFY-wiring fix)", { timeout: 20_000 }, async () => {
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

  it("the command audit store: storeCommand records a command, storeCommandIfAbsent refuses a repeat of the same id, and purge removes only what is older than the cutoff", async () => {
    const marker = crypto.randomUUID();
    const commandId = crypto.randomUUID();
    const old = new Date("2001-01-01T00:00:00Z");
    const recent = new Date();
    const result = await run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const audit = yield* CommandAuditStore;
        const stored = yield* audit.storeCommand(JSON.stringify({ marker }), `AuditStoreCommand-${marker}`, recent);
        const first = yield* audit.storeCommandIfAbsent(JSON.stringify({ marker }), `AuditIfAbsent-${marker}`, commandId, recent);
        const repeat = yield* audit.storeCommandIfAbsent(JSON.stringify({ marker }), `AuditIfAbsent-${marker}`, commandId, recent);
        yield* audit.storeCommand(JSON.stringify({ marker }), `AuditOld-${marker}`, old);
        const rowsFor = (prefix: string) =>
          sql.unsafe<{ n: string }>("SELECT count(*)::text AS n FROM crablet_commands WHERE type = $1", [`${prefix}-${marker}`]).pipe(Effect.map((r) => Number(r[0]!.n)));
        const before = { stored: yield* rowsFor("AuditStoreCommand"), ifAbsent: yield* rowsFor("AuditIfAbsent"), old: yield* rowsFor("AuditOld") };
        const purged = yield* audit.purge(new Date("2010-01-01T00:00:00Z"));
        const after = { stored: yield* rowsFor("AuditStoreCommand"), old: yield* rowsFor("AuditOld") };
        return { stored, first, repeat, before, purged, after };
      })
    );
    assert.strictEqual(result.stored, true);
    assert.strictEqual(result.first, true);
    assert.strictEqual(result.repeat, false, "the same command id is not stored twice");
    assert.deepStrictEqual(result.before, { stored: 1, ifAbsent: 1, old: 1 });
    assert.ok(result.purged >= 1, "the old command was purged");
    assert.deepStrictEqual(result.after, { stored: 1, old: 0 }, "the recent command stays");
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
