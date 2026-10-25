// Runs under Node (Testcontainers). The payment deadline end to end (ADR-0043): a subscription made over HTTP sets it, and the deadlines processor, here
// running with a clock past the payment window, releases the unpaid seat; the seats view gives it back.
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { Clock, Effect, Exit, ManagedRuntime, Redacted, Scope } from "effect";
import { SqlClient } from "effect/sql";
import * as Crablet from "@crablet/commands/Crablet";
import { startTestDb, type TestDb } from "@crablet/test-support";
import { startCourseAppForTest, type RunningCourseApp } from "../support/startCourseAppForTest.ts";
import { applyAppMigrations } from "../support/applyAppMigrations.ts";
import { startCourseDeadlines } from "../../src/CourseApp.ts";
import { PAYMENT_WINDOW_DAYS } from "../../src/domain/Payments.ts";

let db: TestDb;
let app: RunningCourseApp;
let runtime: ManagedRuntime.ManagedRuntime<Crablet.Services, unknown>;
before(async () => {
  db = await startTestDb();
  await applyAppMigrations(db.connInfo);
  app = await startCourseAppForTest(db.connInfo);
  const c = db.connInfo;
  runtime = ManagedRuntime.make(Crablet.layer({ host: c.host, port: c.port, database: c.database, username: c.username, password: Redacted.make(c.password) }));
}, { timeout: 60_000 });
after(async () => {
  await app.stop();
  await runtime.dispose();
  await db.stop();
});

const post = (command: string, body: unknown) =>
  fetch(`${app.baseUrl}/api/commands/${command}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
const query = <T extends object>(text: string, params: ReadonlyArray<unknown> = []) =>
  runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, (sql) => sql.unsafe<T>(text, params as Array<unknown>)));
const until = async <T>(read: () => Promise<T>, ok: (v: T) => boolean, what: string, ms = 20_000): Promise<T> => {
  const end = Date.now() + ms;
  for (;;) {
    const v = await read();
    if (ok(v)) return v;
    if (Date.now() > end) assert.fail(`timed out waiting for ${what}; last: ${JSON.stringify(v)}`);
    await new Promise((r) => setTimeout(r, 200));
  }
};

// The Effect clock, moved `offsetMs` ahead: what the deadlines processor reads as now (sleeping stays real).
const ahead = <A, E, R>(offsetMs: number, effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
  Effect.flatMap(Clock.Clock, (base) =>
    Effect.provideService(effect, Clock.Clock, Object.assign(Object.create(base), {
      currentTimeMillisUnsafe: () => Date.now() + offsetMs,
      currentTimeMillis: Effect.sync(() => Date.now() + offsetMs)
    }) as Clock.Clock)
  );

describe("the payment deadline, end to end", () => {
  it("a subscription over HTTP sets the deadline; past the window, the processor releases the unpaid seat and the seats view frees it", { timeout: 60_000 }, async () => {
    const courseId = `math-${crypto.randomUUID().slice(0, 8)}`;
    const studentId = `ann-${crypto.randomUUID().slice(0, 8)}`;
    assert.strictEqual((await post("define_course", { courseId, capacity: 1 })).status, 201);
    assert.strictEqual((await post("subscribe", { studentId, courseId })).status, 201);
    const [pending] = await query<{ due_at: Date }>(
      "SELECT d.due_at FROM crablet_deadlines d JOIN crablet_events e ON e.position = d.deadline_position WHERE e.data -> 'input' ->> 'studentId' = $1",
      [studentId]
    );
    assert.ok(pending !== undefined, "subscribing set a deadline");
    const days = (pending.due_at.getTime() - Date.now()) / 86_400_000;
    assert.ok(days > PAYMENT_WINDOW_DAYS - 0.01 && days <= PAYMENT_WINDOW_DAYS, `due when the window closes, ${PAYMENT_WINDOW_DAYS} days on (got ${days})`);

    const scope = await runtime.runPromise(Scope.make());
    await runtime.runPromise(Scope.provide(ahead(PAYMENT_WINDOW_DAYS * 86_400_000 + 60_000, startCourseDeadlines("deadlines-e2e")), scope));
    try {
      await until(
        () => query<{ type: string }>("SELECT type FROM crablet_events WHERE type = 'SubscriptionReleased' AND tags @> ARRAY[$1::text]", [`student_id=${studentId}`]),
        (rows) => rows.length === 1,
        "the unpaid seat to be released"
      );
      await until(() => query<{ subscribers: number }>("SELECT subscribers FROM course_seats_view WHERE course_id = $1", [courseId]), (r) => r[0]?.subscribers === 0, "the seats view to free the seat");
      assert.strictEqual((await post("subscribe", { studentId: `bob-${crypto.randomUUID().slice(0, 8)}`, courseId })).status, 201, "the freed seat takes another student");
    } finally {
      await runtime.runPromise(Scope.close(scope, Exit.void));
    }
  });
});
