// Runs under Node (Testcontainers). The seats view is declared with defineView (src/views/CourseSeatsViewProjector.ts). Its writes must join the transaction of the `sql` the projector is given
// (what makes a failed batch roll back with its cursor).
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { Effect, Exit, Layer, ManagedRuntime, Redacted } from "effect";
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
  type, tags: [], data, transactionId: "1", position, occurredAt: new Date(), correlationId: null, causationId: null
});
const seats = (courseId: string) =>
  runtime.runPromise(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      return (yield* sql.unsafe<{ subscribers: number; capacity: number }>("SELECT subscribers, capacity FROM course_seats_view WHERE course_id = $1", [courseId]))[0];
    })
  );

describe("course seats view writes", () => {
  it("its writes are in the transaction of the sql it is given: if the batch's transaction rolls back, the view rolls back with it", async () => {
    const courseId = `c-${crypto.randomUUID().slice(0, 8)}`;
    const exit = await runtime.runPromiseExit(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const projector = yield* makeCourseSeatsViewProjector();
        // what the processor does: the batch and the cursor in one transaction, which here fails after the projector has written
        yield* sql.withTransaction(
          Effect.gen(function* () {
            yield* projector.handle([stored(CourseDefined.type, { courseId, capacity: 5 }, 200n)]);
            return yield* Effect.fail("the cursor could not be moved");
          })
        );
      })
    );
    assert.ok(Exit.isFailure(exit));
    assert.strictEqual(await seats(courseId), undefined, "the row was written inside the failed transaction, so it is gone");
  });
});
