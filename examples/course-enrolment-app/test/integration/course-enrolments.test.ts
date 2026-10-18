// Runs under Node (Testcontainers). GET /api/courses/:courseId/enrolments: the read over the view written with its own SQL (src/views/CourseEnrolmentsViewProjector.ts), end to end: commands in, the view
// written by the projector the app registered, a consistent read out.
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { startTestDb, type TestDb } from "@crablet/test-support";
import { applyAppMigrations } from "../support/applyAppMigrations.ts";
import { startCourseAppForTest, type RunningCourseApp } from "../support/startCourseAppForTest.ts";

let db: TestDb;
let app: RunningCourseApp;

const post = (name: string, body: unknown) =>
  fetch(`${app.baseUrl}/api/commands/${name}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
const enrolments = async (courseId: string) => {
  const res = await fetch(`${app.baseUrl}/api/courses/${courseId}/enrolments`);
  return { status: res.status, body: (await res.json()) as { courseId: string; students: ReadonlyArray<{ studentId: string; seatNumber: number }> } };
};

before(async () => {
  db = await startTestDb();
  await applyAppMigrations(db.connInfo);
  app = await startCourseAppForTest(db.connInfo);
}, { timeout: 120_000 });
after(async () => {
  await app.stop();
  await db.stop();
});

describe("GET /api/courses/:courseId/enrolments", () => {
  it("lists the students in the order they subscribed, each with their seat number, and a read made right after the writes includes them", { timeout: 60_000 }, async () => {
    assert.strictEqual((await post("define_course", { courseId: "chem", capacity: 5 })).status, 201);
    assert.strictEqual((await post("define_course", { courseId: "geo", capacity: 5 })).status, 201);
    for (const studentId of ["ann", "bob", "cy"]) assert.strictEqual((await post("subscribe", { studentId, courseId: "chem" })).status, 201);
    assert.strictEqual((await post("subscribe", { studentId: "ann", courseId: "geo" })).status, 201);

    const chem = await enrolments("chem");
    assert.strictEqual(chem.status, 200);
    assert.deepStrictEqual(chem.body, {
      courseId: "chem",
      students: [{ studentId: "ann", seatNumber: 1 }, { studentId: "bob", seatNumber: 2 }, { studentId: "cy", seatNumber: 3 }]
    });
    assert.deepStrictEqual((await enrolments("geo")).body.students, [{ studentId: "ann", seatNumber: 1 }]);
  });

  it("a course nobody subscribed to, or that does not exist, answers an empty list", { timeout: 30_000 }, async () => {
    assert.deepStrictEqual((await enrolments("nobody")).body, { courseId: "nobody", students: [] });
  });
});
