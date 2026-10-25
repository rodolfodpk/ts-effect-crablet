// Runs under Node (Testcontainers). The view written with its own SQL (src/views/CourseEnrolmentsViewProjector.ts): nothing checks its SQL text but this test.
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { Effect, Exit, Layer, ManagedRuntime, Redacted } from "effect";
import { SqlClient } from "effect/sql";
import { PgClient } from "@effect/sql-pg";
import type { StoredEvent } from "@crablet/eventstore";
import * as Crablet from "@crablet/commands/Crablet";
import { startTestDb, type TestDb } from "@crablet/test-support";
import { CourseCancelled, StudentSubscribed, SubscriptionReleased } from "../../src/domain/Enrolment.ts";
import { CourseEnrolmentsView } from "../../src/views/CourseEnrolmentsViewProjector.ts";
import { applyAppMigrations } from "../support/applyAppMigrations.ts";

let db: TestDb;
let runtime: ManagedRuntime.ManagedRuntime<SqlClient.SqlClient | PgClient.PgClient, never>;
before(async () => {
  db = await startTestDb();
  await applyAppMigrations(db.connInfo);
  runtime = ManagedRuntime.make(
    Crablet.layer({ host: db.connInfo.host, port: db.connInfo.port, database: db.connInfo.database, username: db.connInfo.username, password: Redacted.make(db.connInfo.password) }) as unknown as Layer.Layer<SqlClient.SqlClient | PgClient.PgClient, never>
  );
}, { timeout: 60_000 });
after(async () => {
  await runtime.dispose();
  await db.stop();
});

let position = 1n;
const subscribed = (studentId: string, courseId: string, data: unknown = { studentId, courseId }): StoredEvent => ({
  eventId: crypto.randomUUID(),
  type: StudentSubscribed.type, tags: [], data, transactionId: "1", position: position++, occurredAt: new Date(), correlationId: null, causationId: null
});
const released = (studentId: string, courseId: string): StoredEvent => ({
  eventId: crypto.randomUUID(),
  type: SubscriptionReleased.type, tags: [], data: { studentId, courseId }, transactionId: "1", position: position++, occurredAt: new Date(), correlationId: null, causationId: null
});
const cancelled = (courseId: string, studentIds: ReadonlyArray<string>): StoredEvent => ({
  eventId: crypto.randomUUID(),
  type: CourseCancelled.type, tags: [], data: { courseId, missing: ["room"], studentIds }, transactionId: "1", position: position++, occurredAt: new Date(), correlationId: null, causationId: null
});
const seats = (courseId: string) =>
  runtime.runPromise(
    Effect.flatMap(SqlClient.SqlClient, (sql) =>
      sql.unsafe<{ student_id: string; seat_number: number }>("SELECT student_id, seat_number FROM course_enrolments_view WHERE course_id = $1 ORDER BY seat_number", [courseId])
    )
  );
const handle = (events: ReadonlyArray<StoredEvent>) => runtime.runPromiseExit(Effect.flatMap(CourseEnrolmentsView.projector, (p) => p.handle(events)));

describe("course enrolments view (its own SQL, through raw)", () => {
  it("numbers the seats in the order the students subscribed, per course, and a student appears once", async () => {
    const a = `c-${crypto.randomUUID().slice(0, 8)}`;
    const b = `c-${crypto.randomUUID().slice(0, 8)}`;
    await handle([subscribed("ann", a), subscribed("bob", a), subscribed("cy", b)]);
    await handle([subscribed("dee", a), subscribed("ann", a)]); // ann again: already has her seat
    assert.deepStrictEqual(await seats(a), [{ student_id: "ann", seat_number: 1 }, { student_id: "bob", seat_number: 2 }, { student_id: "dee", seat_number: 3 }]);
    assert.deepStrictEqual(await seats(b), [{ student_id: "cy", seat_number: 1 }]);
  });

  it("a release removes the student's row, and a seat number is never given twice", async () => {
    const c = `c-${crypto.randomUUID().slice(0, 8)}`;
    await handle([subscribed("ann", c), subscribed("bob", c), released("ann", c), subscribed("cy", c)]);
    assert.deepStrictEqual(await seats(c), [{ student_id: "bob", seat_number: 2 }, { student_id: "cy", seat_number: 3 }]);
  });

  it("a cancelled course removes every row it names, and only that course's", async () => {
    const c = `c-${crypto.randomUUID().slice(0, 8)}`;
    const other = `c-${crypto.randomUUID().slice(0, 8)}`;
    await handle([subscribed("ann", c), subscribed("bob", c), subscribed("ann", other), cancelled(c, ["ann", "bob"])]);
    assert.deepStrictEqual(await seats(c), []);
    assert.deepStrictEqual(await seats(other), [{ student_id: "ann", seat_number: 1 }]);
  });

  it("an unreadable event fails the batch with a typed EventDecodingError, and nothing of the batch is written", async () => {
    const c = `c-${crypto.randomUUID().slice(0, 8)}`;
    const exit = await handle([subscribed("ann", c), subscribed("bob", c, { studentId: 42 })]);
    assert.ok(Exit.isFailure(exit));
    assert.ok(JSON.stringify(exit, (_k, v) => (typeof v === "bigint" ? v.toString() : v)).includes("EventDecodingError"));
    assert.deepStrictEqual(await seats(c), []);
  });

  it("its subscription is the event type it handles", () => {
    assert.deepStrictEqual([...CourseEnrolmentsView.subscription().eventTypes], [StudentSubscribed.type, SubscriptionReleased.type, CourseCancelled.type]);
  });
});
