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

const getRaw = async (path: string) => {
  const res = await fetch(`${app.baseUrl}${path}`);
  return { status: res.status, headers: res.headers, body: (await res.json()) as Record<string, any> };
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

  it("a read that carries the write's marker waits for the view; without one it is stale (the course app does not wait unmarked reads)", { timeout: 30_000 }, async () => {
    const courseId = `marked-${crypto.randomUUID().slice(0, 8)}`;
    const define = (await (await post("define_course", { courseId, capacity: 3 })).json()) as { marker: string };
    assert.match(define.marker, /^\d+:\d+$/, "a command's response carries the write's marker");

    assert.strictEqual((await getRaw(`/api/courses/${courseId}`)).status, 404, "no marker: the read does not wait, the view has not seen it");

    const marked = await getRaw(`/api/courses/${courseId}?consistentWith=${define.marker}`);
    assert.strictEqual(marked.status, 200, "with the marker the read waited for the view");
    assert.strictEqual(marked.body["seatsLeft"], 3);
    assert.strictEqual(marked.headers.get("crablet-consistency"), null);

    // the list endpoint is consistent in the same way
    const subscribe = (await (await post("subscribe", { studentId: "ann", courseId })).json()) as { marker: string };
    const listed = await getRaw(`/api/courses?q=${courseId}&consistentWith=${subscribe.marker}`);
    assert.strictEqual(listed.status, 200);
    assert.deepStrictEqual(listed.body["items"].map((c: { seatsLeft: number }) => c.seatsLeft), [2]);
  });

  it("a client can loosen a read (this app allows it): eventual does not wait, bounded answers stale after the timeout; strict refuses with a 503", { timeout: 30_000 }, async () => {
    const courseId = `loose-${crypto.randomUUID().slice(0, 8)}`;
    const define = (await (await post("define_course", { courseId, capacity: 3 })).json()) as { marker: string };
    await getRaw(`/api/courses/${courseId}?consistentWith=${define.marker}`); // the course is in the view
    const subscribe = (await (await post("subscribe", { studentId: "bob", courseId })).json()) as { marker: string };

    const eventual = await getRaw(`/api/courses/${courseId}?consistentWith=${subscribe.marker}&consistency=eventual`);
    assert.strictEqual(eventual.body["seatsLeft"], 3, "eventual does not wait: the subscription is not in the view yet");
    assert.strictEqual(eventual.headers.get("crablet-consistency"), null);

    const bounded = await getRaw(`/api/courses/${courseId}?consistentWith=${subscribe.marker}&consistency=bounded&waitTimeout=50`);
    assert.strictEqual(bounded.status, 200);
    assert.strictEqual(bounded.headers.get("crablet-consistency"), "stale", "bounded ran out of time and says so");
    assert.strictEqual(bounded.body["seatsLeft"], 3);

    const strict = await getRaw(`/api/courses/${courseId}?consistentWith=${subscribe.marker}&waitTimeout=50`);
    assert.strictEqual(strict.status, 503);
    assert.strictEqual(strict.headers.get("retry-after"), "1");
    assert.deepStrictEqual((strict.body["views"] as Array<{ name: string }>).map((v) => v.name), ["course-seats-view"]);

    const waited = await getRaw(`/api/courses/${courseId}?consistentWith=latest`);
    assert.strictEqual(waited.body["seatsLeft"], 2, "latest waits for everything committed when the request arrived");
  });
});
