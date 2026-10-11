// Runs under Node (Testcontainers). The seats view's projector with its SQL built by Kysely (src/views/CourseSeatsViewProjectorKysely.ts): it must behave exactly like the hand-written one, and its writes must join the transaction
// of the `sql` it is given, because Kysely here only builds the query and never holds a connection.
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { Effect, Exit, Layer, ManagedRuntime, Redacted } from "effect";
import { SqlClient } from "effect/sql";
import { PgClient } from "@effect/sql-pg";
import type { StoredEvent } from "@crablet/eventstore";
import * as Crablet from "@crablet/commands/Crablet";
import { startTestDb, type TestDb } from "@crablet/test-support";
import { CourseDefined, StudentSubscribed } from "../../src/domain/Enrolment.ts";
import { makeCourseSeatsViewProjectorKysely } from "../../src/views/CourseSeatsViewProjectorKysely.ts";
import { qb } from "../../src/views/queryBuilder.ts";
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
      return (yield* sql.unsafe<{ subscribers: number; capacity: number; last_position: bigint }>("SELECT subscribers, capacity, last_position FROM course_seats_view WHERE course_id = $1", [courseId]))[0];
    })
  );

describe("course seats view projector, SQL built by Kysely", () => {
  it("applies each event once: a redelivered or older event changes nothing (the same behaviour as the hand-written projector)", async () => {
    const courseId = `c-${crypto.randomUUID().slice(0, 8)}`;
    const defined = stored(CourseDefined.type, { courseId, capacity: 3 }, 100n);
    const first = stored(StudentSubscribed.type, { studentId: "ann", courseId }, 101n);
    const second = stored(StudentSubscribed.type, { studentId: "bob", courseId }, 102n);
    await runtime.runPromise(
      Effect.gen(function* () {
        const projector = yield* makeCourseSeatsViewProjectorKysely();
        yield* projector.handle([defined, first]);
        yield* projector.handle([first]); // delivered again
        yield* projector.handle([defined, first, second]); // a whole batch again, plus one new event
        yield* projector.handle([first]); // older than the row's last position
      })
    );
    assert.deepStrictEqual(await seats(courseId), { subscribers: 2, capacity: 3, last_position: 102n });
  });

  it("its writes are in the transaction of the sql it is given: if the batch's transaction rolls back, the view rolls back with it", async () => {
    const courseId = `c-${crypto.randomUUID().slice(0, 8)}`;
    const exit = await runtime.runPromiseExit(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const projector = yield* makeCourseSeatsViewProjectorKysely();
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

// Compile-time checks, not run: each line below must be a type error, or the Kysely types are not protecting anything (a line that stops being an error fails the type check).
export const typeErrors = () => {
  // @ts-expect-error a column that does not exist
  qb.updateTable("course_seats_view").set({ subscriberz: 1 });
  // @ts-expect-error a table that does not exist
  qb.selectFrom("course_seatz_view");
  // @ts-expect-error capacity is a number
  qb.insertInto("course_seats_view").values({ course_id: "c", capacity: "three", last_position: 1n });
  // @ts-expect-error a column compared with a value of another type
  qb.selectFrom("course_seats_view").where("course_id", "=", 42);
};
