// Runs under Node (Testcontainers): the command audit store against Postgres, and the linkage it relies on, a command and its events written in
// one transaction share its transaction_id.
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { Effect, Layer, Redacted } from "effect";
import { SqlClient } from "effect/sql";
import { PgClient } from "@effect/sql-pg";
import { startTestDb, type TestDb } from "@crablet/test-support";
import { EventStore, EventStoreLive } from "@crablet/eventstore";
import * as AppendEvent from "@crablet/eventstore/AppendEvent";
import { CommandAuditStore, CommandAuditStoreLive } from "../../src/CommandAuditStore.ts";

let db: TestDb;
let layer: Layer.Layer<EventStore | CommandAuditStore | SqlClient.SqlClient | PgClient.PgClient, never>;

before(async () => {
  db = await startTestDb();
  const pgLayer = PgClient.layer({
    host: db.connInfo.host,
    port: db.connInfo.port,
    database: db.connInfo.database,
    username: db.connInfo.username,
    password: Redacted.make(db.connInfo.password)
  });
  // orDie: a test that cannot reach its database has nothing to test.
  layer = Layer.provideMerge(Layer.merge(EventStoreLive, CommandAuditStoreLive), pgLayer).pipe(Layer.orDie);
}, { timeout: 60_000 });

after(async () => {
  await db.stop();
});

const run = <A, E>(effect: Effect.Effect<A, E, EventStore | CommandAuditStore | SqlClient.SqlClient>) =>
  Effect.runPromise(Effect.provide(effect, layer));

describe("CommandAuditStore (Postgres)", () => {
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
