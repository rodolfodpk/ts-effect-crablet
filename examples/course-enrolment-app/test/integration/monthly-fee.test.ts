// Runs under Node (Testcontainers). The monthly fee (src/features/monthly-fee) on Postgres:
// - a payment and the release of the same invoice, run at the same time, never both happen: their appends conflict over the invoice's events;
// - end to end with the deadlines processor: starting the billing issues invoice 1, and past its due date the unpaid seat is released and the seats
//   view frees it.
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { Clock, Deferred, Effect, Exit, Fiber, ManagedRuntime, Redacted, Scope } from "effect";
import { SqlClient } from "effect/sql";
import * as Crablet from "@crablet/commands/Crablet";
import { CommandExecutor } from "@crablet/commands";
import type { Command } from "@crablet/commands/Command";
import { startTestDb, type TestDb } from "@crablet/test-support";
import { startCourseAppForTest, type RunningCourseApp } from "../support/startCourseAppForTest.ts";
import { applyAppMigrations } from "../support/applyAppMigrations.ts";
import { startCourseDeadlines } from "../../src/CourseApp.ts";
import { DefineCourse, Subscribe } from "../../src/domain/Enrolment.ts";
import { PriceCourse } from "../../src/domain/Payments.ts";
import { INVOICE_DUE_DAYS, invoiceIdOf, IssueInvoice, PayInvoice, ReleaseOverdueInvoice, StartMonthlyFee } from "../../src/features/monthly-fee/index.ts";

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

const uid = () => crypto.randomUUID().slice(0, 8);
const run = <In>(command: Command<In, any>, input: In) => runtime.runPromise(Effect.exit(Effect.flatMap(CommandExecutor, (executor) => executor.run(command, input))));
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
const countOf = async (type: string, tag: string) =>
  (await query<{ n: number }>("SELECT count(*)::int AS n FROM crablet_events WHERE type = $1 AND tags @> ARRAY[$2::text]", [type, tag]))[0]!.n;

// The Effect clock, moved `offsetMs` ahead: what the deadlines processor reads as now (sleeping stays real). As in course-deadlines.test.ts.
const ahead = <A, E, R>(offsetMs: number, effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
  Effect.flatMap(Clock.Clock, (base) =>
    Effect.provideService(effect, Clock.Clock, Object.assign(Object.create(base), {
      currentTimeMillisUnsafe: () => Date.now() + offsetMs,
      currentTimeMillis: Effect.sync(() => Date.now() + offsetMs)
    }) as Clock.Clock)
  );

// A student subscribed to a priced course and billed monthly by `billingId`.
const billedStudent = async (capacity = 30) => {
  const courseId = `math-${uid()}`;
  const studentId = `ann-${uid()}`;
  const billingId = `b-${uid()}`;
  for (const [command, input] of [
    [DefineCourse, { courseId, capacity }],
    [PriceCourse, { courseId, price: 12000 }],
    [Subscribe, { courseId, studentId }],
    [StartMonthlyFee, { billingId, courseId, studentId }]
  ] as const) assert.ok(Exit.isSuccess(await run(command as Command<any, any>, input)), `${command.name} ran`);
  return { courseId, studentId, billingId };
};

describe("the monthly fee on Postgres", () => {
  it("a payment and the release of the same invoice, both read before either appends, never both happen", { timeout: 120_000 }, async () => {
    for (let round = 0; round < 15; round++) {
      const { courseId, studentId, billingId } = await billedStudent();
      assert.ok(Exit.isSuccess(await run(IssueInvoice, { billingId, courseId, studentId, n: 1 })));
      const invoiceTag = `invoice_id=${invoiceIdOf(billingId, 1)}`;
      // Both are allowed on their own (the invoice is not due yet, and the release's deadline is what times it): only the boundary decides. To make
      // them race for real, a transaction holds the writer locks their appends take ((type, tag), exclusive) until both have read and are waiting.
      const gate = await runtime.runPromise(Deferred.make<void>());
      const held = await runtime.runPromise(Deferred.make<void>());
      const blocker = runtime.runFork(
        Effect.flatMap(SqlClient.SqlClient, (sql) =>
          sql.withTransaction(
            Effect.gen(function* () {
              for (const type of ["InvoicePaid", "InvoiceOverdue"]) yield* sql`SELECT pg_advisory_xact_lock(crablet_leaf_lock_key(${type}, ${invoiceTag}))`;
              yield* Deferred.succeed(held, undefined);
              yield* Deferred.await(gate);
            })
          )
        )
      );
      await runtime.runPromise(Deferred.await(held));
      const racing = Promise.all([
        run(PayInvoice, { billingId, n: 1, paymentId: `p-${uid()}`, amount: 12000 }),
        run(ReleaseOverdueInvoice, { billingId, courseId, studentId, n: 1 })
      ]);
      await until(() => query<{ n: number }>("SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND NOT granted"), (r) => r[0]!.n >= 2, "both appends to wait");
      await runtime.runPromise(Deferred.succeed(gate, undefined));
      await racing;
      await runtime.runPromise(Fiber.join(blocker));
      const paid = await countOf("InvoicePaid", invoiceTag);
      const overdue = await countOf("InvoiceOverdue", invoiceTag);
      assert.strictEqual(paid + overdue, 1, `round ${round}: exactly one of paid (${paid}) and released (${overdue})`);
      assert.strictEqual(await countOf("SubscriptionReleased", `student_id=${studentId}`), overdue, `round ${round}: the seat is released exactly when the invoice is`);
    }
  });

  it("the deadlines processor issues invoice 1, and past its due date releases the unpaid seat; the seats view frees it", { timeout: 60_000 }, async () => {
    const { courseId, studentId, billingId } = await billedStudent(1);

    const issuing = await runtime.runPromise(Scope.make());
    await runtime.runPromise(Scope.provide(startCourseDeadlines("monthly-fee-issue"), issuing));
    try {
      await until(() => countOf("InvoiceIssued", `billing_id=${billingId}`), (n) => n === 1, "invoice 1 to be issued");
    } finally {
      await runtime.runPromise(Scope.close(issuing, Exit.void));
    }
    assert.strictEqual(await countOf("SubscriptionReleased", `student_id=${studentId}`), 0, "not released before its due date");

    const releasing = await runtime.runPromise(Scope.make());
    await runtime.runPromise(Scope.provide(ahead(INVOICE_DUE_DAYS * 86_400_000 + 60_000, startCourseDeadlines("monthly-fee-release")), releasing));
    try {
      await until(() => countOf("InvoiceOverdue", `billing_id=${billingId}`), (n) => n === 1, "invoice 1 to be released for being overdue");
      assert.strictEqual(await countOf("SubscriptionReleased", `student_id=${studentId}`), 1);
      await until(() => query<{ subscribers: number }>("SELECT subscribers FROM course_seats_view WHERE course_id = $1", [courseId]), (r) => r[0]?.subscribers === 0, "the seats view to free the seat");
    } finally {
      await runtime.runPromise(Scope.close(releasing, Exit.void));
    }
  });
});
