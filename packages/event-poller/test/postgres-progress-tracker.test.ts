// Runs under Node (Testcontainers) - see NOTES.md.
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { Effect, Layer, Redacted } from "effect";
import { SqlClient } from "@effect/sql";
import { PgClient } from "@effect/sql-pg";
import { startTestDb, type TestDb } from "@crablet/test-support";
import { makePostgresProgressTracker } from "../src/PostgresProgressTracker.ts";

let db: TestDb;
let layer: Layer.Layer<SqlClient.SqlClient, never>;

before(async () => {
  db = await startTestDb();
  layer = PgClient.layer({
    host: db.connInfo.host,
    port: db.connInfo.port,
    database: db.connInfo.database,
    username: db.connInfo.username,
    password: Redacted.make(db.connInfo.password)
  }) as unknown as Layer.Layer<SqlClient.SqlClient, never>;
}, { timeout: 60_000 });

after(async () => {
  await db.stop();
});

const run = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>) =>
  Effect.runPromise(Effect.provide(effect, layer) as Effect.Effect<A, E, never>);

// Phase 2 borrows the already-migrated crablet_view_progress table (single-key shape) purely to
// validate the generic tracker implementation - Phase 3's real Views module will point the same
// generic tracker at this table for its actual purpose. See the Phase 2 plan for why no new
// migration was added.
const SPEC = { tableName: "crablet_view_progress", idColumn: "view_name" } as const;

describe("PostgresProgressTracker (against crablet_view_progress)", () => {
  it("getStatus defaults to ACTIVE when no row exists yet", async () => {
    const id = `view-${crypto.randomUUID()}`;
    const status = await run(
      Effect.gen(function* () {
        const tracker = yield* makePostgresProgressTracker<string>(SPEC);
        return yield* tracker.getStatus(id);
      })
    );
    assert.strictEqual(status, "ACTIVE");
  });

  it("autoRegister is idempotent (ON CONFLICT DO NOTHING)", async () => {
    const id = `view-${crypto.randomUUID()}`;
    const result = await run(
      Effect.gen(function* () {
        const tracker = yield* makePostgresProgressTracker<string>(SPEC);
        yield* tracker.autoRegister(id, "instance-a");
        yield* tracker.updateProgress(id, 42n);
        yield* tracker.autoRegister(id, "instance-b"); // must NOT reset last_position back to 0
        return yield* tracker.getLastPosition(id);
      })
    );
    assert.strictEqual(result, 42n);
  });

  it("getLastPosition/updateProgress round-trip", async () => {
    const id = `view-${crypto.randomUUID()}`;
    const position = await run(
      Effect.gen(function* () {
        const tracker = yield* makePostgresProgressTracker<string>(SPEC);
        yield* tracker.autoRegister(id, "instance-a");
        yield* tracker.updateProgress(id, 123n);
        return yield* tracker.getLastPosition(id);
      })
    );
    assert.strictEqual(position, 123n);
  });

  it("recordError increments error_count and flips to FAILED exactly at maxErrors", async () => {
    const id = `view-${crypto.randomUUID()}`;
    const statuses = await run(
      Effect.gen(function* () {
        const tracker = yield* makePostgresProgressTracker<string>(SPEC);
        yield* tracker.autoRegister(id, "instance-a");
        const observed: Array<string> = [];
        for (let i = 0; i < 3; i++) {
          yield* tracker.recordError(id, `boom ${i}`, 3);
          observed.push(yield* tracker.getStatus(id));
        }
        return observed;
      })
    );
    assert.deepStrictEqual(statuses, ["ACTIVE", "ACTIVE", "FAILED"]);
  });

  it("resetErrorCount clears the counter without touching status", async () => {
    const id = `view-${crypto.randomUUID()}`;
    const result = await run(
      Effect.gen(function* () {
        const tracker = yield* makePostgresProgressTracker<string>(SPEC);
        yield* tracker.autoRegister(id, "instance-a");
        yield* tracker.recordError(id, "boom", 10);
        yield* tracker.recordError(id, "boom", 10);
        yield* tracker.setStatus(id, "PAUSED");
        yield* tracker.resetErrorCount(id);
        return yield* tracker.getStatus(id);
      })
    );
    assert.strictEqual(result, "PAUSED");
  });

  it("setStatus/getStatus round-trip through PAUSED/FAILED/ACTIVE", async () => {
    const id = `view-${crypto.randomUUID()}`;
    const observed = await run(
      Effect.gen(function* () {
        const tracker = yield* makePostgresProgressTracker<string>(SPEC);
        yield* tracker.autoRegister(id, "instance-a");
        const seen: Array<string> = [];
        yield* tracker.setStatus(id, "PAUSED");
        seen.push(yield* tracker.getStatus(id));
        yield* tracker.setStatus(id, "FAILED");
        seen.push(yield* tracker.getStatus(id));
        yield* tracker.setStatus(id, "ACTIVE");
        seen.push(yield* tracker.getStatus(id));
        return seen;
      })
    );
    assert.deepStrictEqual(observed, ["PAUSED", "FAILED", "ACTIVE"]);
  });

  it("ProgressTableNotReady surfaces for a genuinely nonexistent table", async () => {
    const id = `view-${crypto.randomUUID()}`;
    const outcome = await run(
      Effect.gen(function* () {
        const tracker = yield* makePostgresProgressTracker<string>({
          tableName: "crablet_definitely_not_a_real_table",
          idColumn: "id"
        });
        return yield* tracker.autoRegister(id, "instance-a").pipe(
          Effect.map(() => "unexpected-success" as const),
          Effect.catchTag("ProgressTableNotReady", () => Effect.succeed("not-ready" as const))
        );
      })
    );
    assert.strictEqual(outcome, "not-ready");
  });

  it("ProgressTableNotReady also surfaces from getLastPosition against a nonexistent table", async () => {
    const id = `view-${crypto.randomUUID()}`;
    const outcome = await run(
      Effect.gen(function* () {
        const tracker = yield* makePostgresProgressTracker<string>({
          tableName: "crablet_definitely_not_a_real_table",
          idColumn: "id"
        });
        return yield* tracker.getLastPosition(id).pipe(
          Effect.map(() => "unexpected-success" as const),
          Effect.catchTag("ProgressTableNotReady", () => Effect.succeed("not-ready" as const))
        );
      })
    );
    assert.strictEqual(outcome, "not-ready");
  });
});
