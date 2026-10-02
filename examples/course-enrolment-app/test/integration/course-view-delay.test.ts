// Runs under Node (Testcontainers). The demo knob: with the seats view held back, a read right after a write is stale,
// and ?waitFor=course-seats-view is what makes the next read right. (Without the knob the view normally catches up in
// milliseconds, which is why the difference is hard to see.)
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { startTestDb, type TestDb } from "@crablet/test-support";
import { applyAppMigrations } from "../support/applyAppMigrations.ts";
import { startCourseAppForTest, type RunningCourseApp } from "../support/startCourseAppForTest.ts";

const DELAY_MS = 400;
let db: TestDb;
let app: RunningCourseApp;

before(async () => {
  db = await startTestDb();
  await applyAppMigrations(db.connInfo);
  app = await startCourseAppForTest(db.connInfo, {}, { viewDelayMs: DELAY_MS });
}, { timeout: 90_000 });
after(async () => {
  await app.stop();
  await db.stop();
});

const post = (name: string, body: unknown, query = "") =>
  fetch(`${app.baseUrl}/api/commands/${name}${query}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
const getCourse = async (courseId: string) => {
  const res = await fetch(`${app.baseUrl}/api/courses/${courseId}`);
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
};

describe("the seats view held back by viewDelayMs", () => {
  it("a read right after a write is stale; after ?waitFor the next read is right", { timeout: 30_000 }, async () => {
    const courseId = `slow-${crypto.randomUUID().slice(0, 8)}`;

    // The course itself is not in the view yet: a read right after defining it finds nothing.
    assert.strictEqual((await post("define_course", { courseId, capacity: 3 })).status, 201);
    assert.strictEqual((await getCourse(courseId)).status, 404, "the view has not seen the definition yet");

    // Waiting for the view makes the same read succeed.
    const waited = await post("define_course", { courseId: `${courseId}-b`, capacity: 3 }, "?waitFor=course-seats-view");
    assert.strictEqual(waited.status, 201);
    assert.strictEqual(((await waited.json()) as { view: { caughtUp: boolean } }).view.caughtUp, true);
    assert.strictEqual((await getCourse(`${courseId}-b`)).status, 200);

    // A subscription made without waiting is not reflected yet...
    await new Promise((resolve) => setTimeout(resolve, DELAY_MS * 2)); // let the first course reach the view
    assert.strictEqual((await post("subscribe", { studentId: "ann", courseId })).status, 201);
    assert.strictEqual((await getCourse(courseId)).body["seatsLeft"], 3, "stale: the subscription is not in the view yet");

    // ...and one made with ?waitFor is, together with everything before it.
    const second = await post("subscribe", { studentId: "bob", courseId }, "?waitFor=course-seats-view");
    assert.strictEqual(((await second.json()) as { view: { caughtUp: boolean } }).view.caughtUp, true);
    assert.strictEqual((await getCourse(courseId)).body["seatsLeft"], 1, "one read after the waited write is right");
  });
});
