// Runs under Node (Testcontainers). GET /api/courses against the real view: keyset pagination, the prefix filter (and that its
// LIKE characters are escaped), bounds on `limit`, and that a list reflects subscriptions.
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { startTestDb, type TestDb } from "@crablet/test-support";
import { applyAppMigrations } from "../support/applyAppMigrations.ts";
import { startCourseAppForTest, type RunningCourseApp } from "../support/startCourseAppForTest.ts";

let db: TestDb;
let app: RunningCourseApp;
const IDS = ["algebra", "art_history", "artXhistory", "biology", "calculus", "physics-101", "physics-201"];

const post = (name: string, body: unknown, waitFor = true) =>
  fetch(`${app.baseUrl}/api/commands/${name}${waitFor ? "?waitFor=course-seats-view" : ""}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
interface Page {
  readonly items: ReadonlyArray<{ courseId: string; capacity: number; subscribers: number; seatsLeft: number }>;
  readonly next: string | null;
}
const list = async (query = ""): Promise<{ status: number; type: string | null; body: Page & Record<string, unknown> }> => {
  const res = await fetch(`${app.baseUrl}/api/courses${query}`);
  return { status: res.status, type: res.headers.get("content-type"), body: (await res.json()) as never };
};
const ids = (page: Page) => page.items.map((i) => i.courseId);

before(async () => {
  db = await startTestDb();
  await applyAppMigrations(db.connInfo);
  app = await startCourseAppForTest(db.connInfo);
  // waitFor on every define: the view has the course before the next request is made
  for (const [n, id] of IDS.entries()) assert.strictEqual((await post("define_course", { courseId: id, capacity: n + 1 })).status, 201);
}, { timeout: 120_000 });
after(async () => {
  await app.stop();
  await db.stop();
});

describe("GET /api/courses", () => {
  it("lists every course with its seats, in one page when it fits", { timeout: 30_000 }, async () => {
    const { status, type, body } = await list();
    assert.strictEqual(status, 200);
    assert.match(type ?? "", /application\/json/);
    assert.deepStrictEqual([...ids(body)].sort(), [...IDS].sort());
    assert.strictEqual(body.next, null);
    const biology = body.items.find((i) => i.courseId === "biology")!;
    assert.deepStrictEqual(biology, { courseId: "biology", capacity: 4, subscribers: 0, seatsLeft: 4 });
  });

  it("pages with limit and the cursor: every course exactly once, in the same order as the single page", { timeout: 30_000 }, async () => {
    const whole = ids((await list()).body);
    const collected: Array<string> = [];
    let after: string | null = null;
    let pages = 0;
    do {
      const { body }: { body: Page } = await list(`?limit=3${after === null ? "" : `&after=${encodeURIComponent(after)}`}`);
      assert.ok(body.items.length <= 3);
      collected.push(...ids(body));
      after = body.next;
      pages++;
    } while (after !== null && pages < 10);
    assert.strictEqual(pages, 3); // 3 + 3 + 1
    assert.deepStrictEqual(collected, whole);
  });

  it("the last page has next = null, and a cursor past the end is an empty page", { timeout: 30_000 }, async () => {
    const { body } = await list("?limit=100");
    assert.strictEqual(body.next, null);
    const past = await list("?after=zzzz");
    assert.deepStrictEqual(past.body, { items: [], next: null });
  });

  it("q keeps only the ids that START with it", { timeout: 30_000 }, async () => {
    assert.deepStrictEqual(ids((await list("?q=phys")).body), ["physics-101", "physics-201"]);
    assert.deepStrictEqual(ids((await list("?q=alg")).body), ["algebra"]);
    assert.deepStrictEqual(ids((await list("?q=ysics")).body), [], "a prefix, not a substring");
    assert.deepStrictEqual([...ids((await list("?q=")).body)].sort(), [...IDS].sort(), "an empty q is no filter");
  });

  it("LIKE characters in q are matched literally", { timeout: 30_000 }, async () => {
    assert.deepStrictEqual(ids((await list(`?q=${encodeURIComponent("art_")}`)).body), ["art_history"]);
    assert.deepStrictEqual(ids((await list(`?q=${encodeURIComponent("%")}`)).body), []);
    assert.deepStrictEqual(ids((await list(`?q=${encodeURIComponent("_")}`)).body), []);
  });

  it("q and the cursor combine", { timeout: 30_000 }, async () => {
    const first = (await list("?q=physics&limit=1")).body;
    assert.deepStrictEqual(ids(first), ["physics-101"]);
    assert.strictEqual(first.next, "physics-101");
    const second = (await list(`?q=physics&limit=1&after=${encodeURIComponent(first.next!)}`)).body;
    assert.deepStrictEqual(ids(second), ["physics-201"]);
    assert.strictEqual(second.next, null);
  });

  it("a bad limit is a 400 problem (the same body as every other 400), nothing is queried", { timeout: 30_000 }, async () => {
    for (const bad of ["0", "101", "-1", "1.5", "abc", ""]) {
      const { status, type, body } = await list(`?limit=${bad}`);
      assert.strictEqual(status, 400, `limit=${bad}`);
      assert.strictEqual(type, "application/problem+json");
      assert.strictEqual(body["detail"], "limit must be a whole number from 1 to 100");
      assert.strictEqual(body["title"], "Bad Request");
    }
  });

  it("reflects subscriptions once the view has them (the read-your-writes wait applies to lists too)", { timeout: 30_000 }, async () => {
    assert.strictEqual((await post("subscribe", { studentId: "ann", courseId: "biology" })).status, 201);
    const biology = (await list("?q=biology")).body.items[0]!;
    assert.deepStrictEqual(biology, { courseId: "biology", capacity: 4, subscribers: 1, seatsLeft: 3 });
  });
});
