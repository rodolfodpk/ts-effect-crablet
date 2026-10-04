// Runs under Node (Testcontainers). The demo knob: with the seats view held back by viewDelayMs, a read that asks not to wait
// (`?consistency=eventual`) is stale right after a write, while the server's default (a read waits for everything committed) and a read
// that carries the write's marker (`?consistentWith=<marker>`) are right. (Without the knob the view normally catches up in milliseconds,
// which is why the difference is hard to see.)
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

const post = async (name: string, body: unknown) => {
  const res = await fetch(`${app.baseUrl}/api/commands/${name}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return { status: res.status, marker: ((await res.json()) as { marker: string | null }).marker };
};
const getRaw = async (path: string) => {
  const res = await fetch(`${app.baseUrl}${path}`);
  return { status: res.status, headers: res.headers, body: (await res.json()) as Record<string, any>, };
};

describe("the seats view held back by viewDelayMs", () => {
  it("a read right after a write: stale if it asks not to wait, right by default - however far behind the view is", { timeout: 30_000 }, async () => {
    const courseId = `slow-${crypto.randomUUID().slice(0, 8)}`;

    // The course itself is not in the view yet: a read that does not wait finds nothing.
    assert.strictEqual((await post("define_course", { courseId, capacity: 3 })).status, 201);
    assert.strictEqual((await getRaw(`/api/courses/${courseId}?consistency=eventual`)).status, 404, "the view has not seen the definition yet");

    // The same read with no parameters waits for everything committed, so it finds the course.
    const started = Date.now();
    const waited = await getRaw(`/api/courses/${courseId}`);
    assert.strictEqual(waited.status, 200);
    assert.ok(Date.now() - started >= DELAY_MS / 4, "and it really waited for the delayed view");

    // A subscription is not in the view right away if the read does not wait...
    assert.strictEqual((await post("subscribe", { studentId: "ann", courseId })).status, 201);
    assert.strictEqual((await getRaw(`/api/courses/${courseId}?consistency=eventual`)).body["seatsLeft"], 3, "stale: the subscription is not in the view yet");

    // ...and it is, together with everything before it, by default.
    assert.strictEqual((await post("subscribe", { studentId: "bob", courseId })).status, 201);
    assert.strictEqual((await getRaw(`/api/courses/${courseId}`)).body["seatsLeft"], 1, "one read after the write is right, with no marker sent");
  });

  it("a read that carries the write's marker waits for exactly that write, on both endpoints", { timeout: 30_000 }, async () => {
    const courseId = `marked-${crypto.randomUUID().slice(0, 8)}`;
    const define = await post("define_course", { courseId, capacity: 3 });
    assert.match(String(define.marker), /^\d+:\d+$/, "a command's response carries the write's marker");

    const marked = await getRaw(`/api/courses/${courseId}?consistentWith=${define.marker}`);
    assert.strictEqual(marked.status, 200, "with the marker the read waited for the view");
    assert.strictEqual(marked.body["seatsLeft"], 3);
    assert.strictEqual(marked.headers.get("crablet-consistency"), null);

    const subscribe = await post("subscribe", { studentId: "ann", courseId });
    const listed = await getRaw(`/api/courses?q=${courseId}&consistentWith=${subscribe.marker}`);
    assert.strictEqual(listed.status, 200);
    assert.deepStrictEqual(listed.body["items"].map((c: { seatsLeft: number }) => c.seatsLeft), [2]);
  });

  it("a client can loosen a read (this app allows it): eventual does not wait, bounded answers stale after the timeout; strict refuses with a 503", { timeout: 30_000 }, async () => {
    const courseId = `loose-${crypto.randomUUID().slice(0, 8)}`;
    const define = await post("define_course", { courseId, capacity: 3 });
    await getRaw(`/api/courses/${courseId}?consistentWith=${define.marker}`); // the course is in the view
    const subscribe = await post("subscribe", { studentId: "bob", courseId });

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
