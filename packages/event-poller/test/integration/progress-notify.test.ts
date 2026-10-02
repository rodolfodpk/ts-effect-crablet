// Runs under Node (Testcontainers) - see NOTES.md.
// A progress tracker with `notifyChannel` pings when a processor advances: one notification per advance, sent in the same statement as
// the update (so it is delivered only once the new cursor has committed), and nothing for a tracker without the option or a row that
// does not exist.
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { Client } from "pg";
import { Effect, Layer, Redacted } from "effect";
import { SqlClient } from "effect/sql";
import { PgClient } from "@effect/sql-pg";
import { startTestDb, type TestDb } from "@crablet/test-support";
import { makePostgresProgressTracker } from "../../src/PostgresProgressTracker.ts";
import * as ProgressCursorNS from "../../src/ProgressCursor.ts";
import { decodeProgressPing, type ProgressPing } from "../../src/ProgressPing.ts";

const CHANNEL = "test_progress_channel";
let db: TestDb;
let layer: Layer.Layer<SqlClient.SqlClient, never>;
let listener: Client;
let reader: Client;
const received: Array<{ readonly payload: string; readonly readBack: string | null }> = [];

before(async () => {
  db = await startTestDb();
  layer = PgClient.layer({
    host: db.connInfo.host,
    port: db.connInfo.port,
    database: db.connInfo.database,
    username: db.connInfo.username,
    password: Redacted.make(db.connInfo.password)
  }) as unknown as Layer.Layer<SqlClient.SqlClient, never>;
  listener = new Client({ host: db.connInfo.host, port: db.connInfo.port, database: db.connInfo.database, user: db.connInfo.username, password: db.connInfo.password });
  await listener.connect();
  await listener.query(`LISTEN ${CHANNEL}`);
  // On every ping, read the progress row back with a SEPARATE connection: the ping must not arrive before the update is visible.
  reader = new Client({ host: db.connInfo.host, port: db.connInfo.port, database: db.connInfo.database, user: db.connInfo.username, password: db.connInfo.password });
  await reader.connect();
  listener.on("notification", (n) => {
    const ping = JSON.parse(n.payload ?? "{}") as ProgressPing;
    void reader
      .query("SELECT last_position::text AS p, last_transaction_id::text AS x FROM crablet_view_progress WHERE view_name = $1", [ping.id])
      .then((r) => received.push({ payload: n.payload ?? "", readBack: r.rows[0] ? `${r.rows[0].x}:${r.rows[0].p}` : null }));
  });
}, { timeout: 60_000 });

after(async () => {
  await listener.end();
  await reader.end();
  await db.stop();
});

const run = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>) =>
  Effect.runPromise(Effect.provide(effect, layer) as Effect.Effect<A, E, never>);

const settle = () => new Promise((resolve) => setTimeout(resolve, 300));
const notifying = { tableName: "crablet_view_progress", idColumn: "view_name", notifyChannel: CHANNEL } as const;
const silent = { tableName: "crablet_view_progress", idColumn: "view_name" } as const;

describe("progress tracker notifications", () => {
  it("sends one ping per advance, with the processor and the new cursor", async () => {
    const id = `view-${crypto.randomUUID()}`;
    await run(
      Effect.gen(function* () {
        const tracker = yield* makePostgresProgressTracker<string>(notifying);
        yield* tracker.autoRegister(id, "instance-a");
        yield* tracker.updateCursor(id, ProgressCursorNS.of("100", 7n));
        yield* tracker.updateCursor(id, ProgressCursorNS.of("101", 9n));
      })
    );
    await settle();
    const mine = received.filter((r) => (JSON.parse(r.payload) as ProgressPing).id === id);
    assert.deepStrictEqual(
      mine.map((r) => JSON.parse(r.payload)),
      [
        { id, transactionId: "100", position: "7" },
        { id, transactionId: "101", position: "9" }
      ]
    );
  });

  it("the ping is delivered only after the new cursor is visible to another connection", async () => {
    const id = `view-${crypto.randomUUID()}`;
    await run(
      Effect.gen(function* () {
        const tracker = yield* makePostgresProgressTracker<string>(notifying);
        yield* tracker.autoRegister(id, "instance-a");
        yield* tracker.updateCursor(id, ProgressCursorNS.of("200", 15n));
      })
    );
    await settle();
    const mine = received.filter((r) => (JSON.parse(r.payload) as ProgressPing).id === id);
    assert.strictEqual(mine.length, 1);
    assert.strictEqual(mine[0]!.readBack, "200:15", "read back on another connection at ping time: the update had already committed");
  });

  it("the payload decodes with the shared ProgressPing schema", async () => {
    const id = `view-${crypto.randomUUID()}`;
    await run(
      Effect.gen(function* () {
        const tracker = yield* makePostgresProgressTracker<string>(notifying);
        yield* tracker.autoRegister(id, "instance-a");
        yield* tracker.updateCursor(id, ProgressCursorNS.of("300", 21n));
      })
    );
    await settle();
    const payload = received.find((r) => (JSON.parse(r.payload) as ProgressPing).id === id)!.payload;
    assert.deepStrictEqual(await Effect.runPromise(decodeProgressPing(payload)), { id, transactionId: "300", position: "21" });
  });

  it("a tracker without notifyChannel sends nothing (automations and the outbox)", async () => {
    const id = `view-${crypto.randomUUID()}`;
    await run(
      Effect.gen(function* () {
        const tracker = yield* makePostgresProgressTracker<string>(silent);
        yield* tracker.autoRegister(id, "instance-a");
        yield* tracker.updateCursor(id, ProgressCursorNS.of("400", 30n));
      })
    );
    await settle();
    assert.strictEqual(received.filter((r) => (JSON.parse(r.payload) as ProgressPing).id === id).length, 0);
  });

  it("updating a processor that has no row sends nothing", async () => {
    const id = `view-${crypto.randomUUID()}`;
    await run(
      Effect.gen(function* () {
        const tracker = yield* makePostgresProgressTracker<string>(notifying);
        yield* tracker.updateCursor(id, ProgressCursorNS.of("500", 40n)); // never autoRegistered
      })
    );
    await settle();
    assert.strictEqual(received.filter((r) => (JSON.parse(r.payload) as ProgressPing).id === id).length, 0);
  });
});
