// Runs under Node (Testcontainers). The seats view's projector: an event delivered again (the poller is at-least-once)
// or out of date must not be applied twice.
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { Effect, Layer, ManagedRuntime, Redacted } from "effect";
import { SqlClient } from "effect/sql";
import { PgClient } from "@effect/sql-pg";
import type { StoredEvent } from "@crablet/eventstore";
import * as Crablet from "@crablet/commands/Crablet";
import { startTestDb, type TestDb } from "@crablet/test-support";
import { CourseDefined, StudentSubscribed } from "../../src/domain/Enrolment.ts";
import { makeCourseSeatsViewProjector } from "../../src/views/CourseSeatsViewProjector.ts";
import { applyAppMigrations } from "../support/applyAppMigrations.ts";

let db: TestDb;
let runtime: ManagedRuntime.ManagedRuntime<SqlClient.SqlClient | PgClient.PgClient, never>;
before(async () => {
  db = await startTestDb();
  await applyAppMigrations(db.connInfo);
  runtime = ManagedRuntime.make(
    Crablet.layer({
      host: db.connInfo.host,
      port: db.connInfo.port,
      database: db.connInfo.database,
      username: db.connInfo.username,
      password: Redacted.make(db.connInfo.password)
    }) as unknown as Layer.Layer<SqlClient.SqlClient | PgClient.PgClient, never>
  );
}, { timeout: 60_000 });
after(async () => {
  await runtime.dispose();
  await db.stop();
});

const stored = (type: string, data: unknown, position: bigint): StoredEvent => ({
  type,
  tags: [],
  data,
  transactionId: "1",
  position,
  occurredAt: new Date(),
  correlationId: null,
  causationId: null
});

describe("course seats view projector", () => {
  it("a course keeps the capacity it was first defined with, and each subscription takes one seat", async () => {
    const courseId = `c-${crypto.randomUUID().slice(0, 8)}`;
    const defined = stored(CourseDefined.type, { courseId, capacity: 3 }, 100n);
    const redefined = stored(CourseDefined.type, { courseId, capacity: 99 }, 101n);
    const first = stored(StudentSubscribed.type, { studentId: "ann", courseId }, 102n);
    const second = stored(StudentSubscribed.type, { studentId: "bob", courseId }, 103n);
    // A subscription for a course the view has not seen yet (its CourseDefined is still on its way) changes nothing.
    const early = stored(StudentSubscribed.type, { studentId: "cy", courseId: `${courseId}-later` }, 104n);

    const row = await runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const projector = yield* makeCourseSeatsViewProjector();
        yield* projector.handle([defined, first]);
        yield* projector.handle([redefined, second, early]);
        const rows = yield* sql.unsafe<{ subscribers: number; capacity: number }>("SELECT subscribers, capacity FROM course_seats_view WHERE course_id = $1", [courseId]);
        const later = yield* sql.unsafe<{ n: string }>("SELECT count(*)::text AS n FROM course_seats_view WHERE course_id = $1", [`${courseId}-later`]);
        return { row: rows[0], later: later[0]!.n };
      })
    );
    assert.deepStrictEqual(row, { row: { subscribers: 2, capacity: 3 }, later: "0" });
  });
});
