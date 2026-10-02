// Runs under Node (Testcontainers). CORS on the REAL API routes (the unit tests in commands-http use stand-in routes): a page on
// another origin gets the headers on a command, on its preflight, on a refusal and on a read, and an unlisted origin gets none.
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { startTestDb, type TestDb } from "@crablet/test-support";
import { applyAppMigrations } from "../support/applyAppMigrations.ts";
import { startCourseAppForTest, type RunningCourseApp } from "../support/startCourseAppForTest.ts";

const PAGE = "http://localhost:5173";
let db: TestDb;
let app: RunningCourseApp;
let plain: RunningCourseApp;

before(async () => {
  db = await startTestDb();
  await applyAppMigrations(db.connInfo);
  app = await startCourseAppForTest(db.connInfo, { cors: { allowedOrigins: [PAGE] } });
  plain = await startCourseAppForTest(db.connInfo, {});
}, { timeout: 90_000 });
after(async () => {
  await plain.stop();
  await app.stop();
  await db.stop();
});

const post = (base: string, name: string, body: unknown, origin?: string) =>
  fetch(`${base}/api/commands/${name}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(origin ? { Origin: origin } : {}) },
    body: JSON.stringify(body)
  });

describe("CORS on the course API", () => {
  it("an allowed origin gets the headers on a command and can read the correlation id", { timeout: 30_000 }, async () => {
    const res = await post(app.baseUrl, "define_course", { courseId: `cors-${crypto.randomUUID().slice(0, 8)}`, capacity: 2 }, PAGE);
    assert.strictEqual(res.status, 201);
    assert.strictEqual(res.headers.get("access-control-allow-origin"), PAGE);
    assert.strictEqual(res.headers.get("access-control-expose-headers"), "X-Correlation-Id");
  });

  it("the preflight for a command is answered with this API's methods and headers", { timeout: 30_000 }, async () => {
    const res = await fetch(`${app.baseUrl}/api/commands/subscribe`, {
      method: "OPTIONS",
      headers: { Origin: PAGE, "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "content-type" }
    });
    assert.ok(res.status < 300, `preflight status ${res.status}`);
    assert.strictEqual(res.headers.get("access-control-allow-origin"), PAGE);
    assert.strictEqual(res.headers.get("access-control-allow-methods"), "GET, POST");
    assert.strictEqual(res.headers.get("access-control-allow-headers"), "Content-Type,X-Correlation-Id");
  });

  it("a refusal and a read carry the headers too, so the page can read the problem", { timeout: 30_000 }, async () => {
    const refused = await post(app.baseUrl, "subscribe", { studentId: "ann", courseId: "ghost" }, PAGE);
    assert.strictEqual(refused.status, 404);
    assert.strictEqual(refused.headers.get("access-control-allow-origin"), PAGE);
    const read = await fetch(`${app.baseUrl}/api/courses/ghost`, { headers: { Origin: PAGE } });
    assert.strictEqual(read.status, 404);
    assert.strictEqual(read.headers.get("access-control-allow-origin"), PAGE);
  });

  it("an origin that is not listed is never allowed: the answer names only the configured origin", { timeout: 30_000 }, async () => {
    // With ONE configured origin the server always answers that origin; the browser compares it with the page's own origin, so a page
    // on https://evil.example.net is blocked. (With several origins an unlisted one gets no header at all: see cors.test.ts.)
    const res = await post(app.baseUrl, "subscribe", { studentId: "ann", courseId: "ghost" }, "https://evil.example.net");
    assert.strictEqual(res.headers.get("access-control-allow-origin"), PAGE);
    assert.notStrictEqual(res.headers.get("access-control-allow-origin"), "*");
  });

  it("without the option no CORS header is sent at all", { timeout: 30_000 }, async () => {
    const res = await post(plain.baseUrl, "subscribe", { studentId: "ann", courseId: "ghost" }, PAGE);
    assert.strictEqual(res.status, 404);
    assert.strictEqual(res.headers.get("access-control-allow-origin"), null);
  });
});
