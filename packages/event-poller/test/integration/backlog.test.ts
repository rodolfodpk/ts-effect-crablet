// Runs under Node (Testcontainers) - see NOTES.md. What is waiting for a processor, counted against ITS selection, on a real database.
// The point: a cursor only ever lands on events the selection matched, so "head of the log minus cursor" (getLag) says a consumer of a rare event type is
// far behind when it has everything. The backlog is the number to alert on.
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { Effect, Layer, Redacted } from "effect";
import { SqlClient } from "effect/sql";
import { PgClient } from "@effect/sql-pg";
import { startTestDb, type TestDb } from "@crablet/test-support";
import { makePostgresProgressTracker } from "../../src/PostgresProgressTracker.ts";
import { makeProcessorManagementService } from "../../src/ProcessorManagementService.ts";
import * as EventSelection from "../../src/EventSelection.ts";
import * as ProgressCursorNS from "../../src/ProgressCursor.ts";

let db: TestDb;
let layer: Layer.Layer<SqlClient.SqlClient, never>;
before(async () => {
  db = await startTestDb();
  layer = PgClient.layer({
    host: db.connInfo.host, port: db.connInfo.port, database: db.connInfo.database,
    username: db.connInfo.username, password: Redacted.make(db.connInfo.password)
  }) as unknown as Layer.Layer<SqlClient.SqlClient, never>;
}, { timeout: 60_000 });
after(async () => { await db.stop(); });

const run = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>) => Effect.runPromise(Effect.provide(effect, layer) as Effect.Effect<A, E, never>);

// An event of `type` that occurred `ageSeconds` ago. Returns the cursor just after it.
const insert = (type: string, ageSeconds = 0, tags: ReadonlyArray<string> = []) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql.unsafe<{ position: string; transaction_id: string }>(
      `INSERT INTO crablet_events (type, tags, data, transaction_id, occurred_at)
       VALUES ($1, ARRAY(SELECT jsonb_array_elements_text($2::jsonb)), '{}'::jsonb, pg_current_xact_id(), now() - make_interval(secs => $3))
       RETURNING position::text AS position, transaction_id::text AS transaction_id`,
      [type, JSON.stringify(tags), ageSeconds]
    );
    return ProgressCursorNS.of(rows[0]!.transaction_id, BigInt(rows[0]!.position));
  });

const serviceFor = (id: string, selection: EventSelection.EventSelection) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const progressTracker = yield* makePostgresProgressTracker<string>({ tableName: "crablet_view_progress", idColumn: "view_name" });
    yield* progressTracker.autoRegister(id, "test-instance");
    const service = makeProcessorManagementService<string>({
      progressTracker,
      getAllStatuses: Effect.succeed(new Map([[id, "ACTIVE" as const]])),
      pauseProcessor: () => Effect.void,
      resumeProcessor: () => Effect.void,
      backoffSnapshot: () => Effect.succeed(null),
      allBackoffSnapshots: Effect.succeed(new Map()),
      selectionOf: (x) => (x === id ? selection : undefined),
      sql
    });
    return { service, progressTracker };
  });

describe("processor backlog against Postgres", () => {
  it("a consumer of a rare event type that has everything shows no backlog, though the whole log is far past its cursor", async () => {
    const id = `rare-${crypto.randomUUID()}`;
    const r = await run(Effect.gen(function* () {
      const { service, progressTracker } = yield* serviceFor(id, EventSelection.of({ eventTypes: new Set(["Rare"]) }));
      for (let i = 0; i < 5; i++) yield* insert("Noise");
      const lastRare = yield* insert("Rare");
      for (let i = 0; i < 4; i++) yield* insert("Noise");
      yield* progressTracker.updateCursor(id, lastRare);
      return { backlog: yield* service.getBacklog(id), lag: yield* service.getLag(id) };
    }));
    assert.strictEqual(r.backlog!.pendingEvents, 0);
    assert.strictEqual(r.backlog!.oldestPendingSeconds, null);
    assert.ok(r.lag! >= 4n, `getLag measures to the head of the whole log (${r.lag}), which is why it cannot be the alert`);
  });

  it("counts only its own events after the cursor, and the age is that of the first of them", async () => {
    const id = `behind-${crypto.randomUUID()}`;
    const r = await run(Effect.gen(function* () {
      const { service, progressTracker } = yield* serviceFor(id, EventSelection.of({ eventTypes: new Set(["Rare"]) }));
      const seen = yield* insert("Rare", 7200);
      yield* progressTracker.updateCursor(id, seen);
      yield* insert("Noise", 5000);
      yield* insert("Rare", 3600);
      yield* insert("Noise", 3000);
      yield* insert("Rare", 60);
      yield* insert("Rare", 1);
      return yield* service.getBacklog(id);
    }));
    assert.strictEqual(r!.pendingEvents, 3);
    assert.ok(r!.oldestPendingSeconds! >= 3599 && r!.oldestPendingSeconds! < 3700, `age of the first pending event: ${r!.oldestPendingSeconds}`);
    assert.strictEqual(r!.capped, false);
  });

  it("a processor that has never run is behind by every event it selects, and the selection's tag clauses apply", async () => {
    const id = `new-${crypto.randomUUID()}`;
    const tag = `wallet_id=${crypto.randomUUID()}`;
    const r = await run(Effect.gen(function* () {
      const { service } = yield* serviceFor(id, EventSelection.of({ eventTypes: new Set(["Deposited"]), exactTags: new Map([[tag.split("=")[0]!, tag.split("=")[1]!]]) }));
      yield* insert("Deposited", 10, [tag]);
      yield* insert("Deposited", 10, [tag]);
      yield* insert("Deposited", 10, ["wallet_id=someone-else"]);
      yield* insert("Withdrawn", 10, [tag]);
      return yield* service.getBacklog(id);
    }));
    assert.strictEqual(r!.pendingEvents, 2);
    assert.deepStrictEqual(r!.cursor, ProgressCursorNS.zero);
  });
});
