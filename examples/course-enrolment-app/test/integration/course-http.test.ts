// Runs under Node (Testcontainers). Tutorial step 3: the API over real HTTP against a real Postgres.
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Effect } from "effect";
import { HttpApiClient } from "effect/http-api";
import { FetchHttpClient } from "effect/http";
import { startTestDb, type TestDb } from "@crablet/test-support";
import { startCourseAppForTest, type RunningCourseApp } from "../support/startCourseAppForTest.ts";
import { applyAppMigrations } from "../support/applyAppMigrations.ts";
import { makeCourseApi } from "../../src/CourseApp.ts";
import { courseOpenApiFile } from "../../src/api/CourseOpenApi.ts";

let db: TestDb;
let app: RunningCourseApp;
before(async () => {
  db = await startTestDb();
  await applyAppMigrations(db.connInfo);
  app = await startCourseAppForTest(db.connInfo);
}, { timeout: 60_000 });
after(async () => {
  await app.stop();
  await db.stop();
});

const uid = () => crypto.randomUUID().slice(0, 8);
const post = (command: string, body: unknown) =>
  fetch(`${app.baseUrl}/api/commands/${command}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
const json = async (res: Response) => (await res.json()) as Record<string, any>;

describe("tutorial step 3: the HTTP API", () => {
  it("define a course (201), subscribe a student (201), and a repeat subscription is 'already done' (200)", async () => {
    const courseId = `math-${uid()}`;
    const defined = await post("define_course", { courseId, capacity: 2 });
    assert.strictEqual(defined.status, 201);
    assert.match(String((await json(defined)).lastPosition), /^\d+$/);

    const ann = `ann-${uid()}`;
    assert.strictEqual((await post("subscribe", { studentId: ann, courseId })).status, 201);
    const repeat = await post("subscribe", { studentId: ann, courseId });
    assert.strictEqual(repeat.status, 200);
    assert.strictEqual((await json(repeat)).status, "IDEMPOTENT");
  });

  it("an unknown course is a 404 problem naming the error and its fields", async () => {
    const res = await post("subscribe", { studentId: `ann-${uid()}`, courseId: "ghost" });
    assert.strictEqual(res.status, 404);
    assert.strictEqual(res.headers.get("content-type"), "application/problem+json");
    const body = await json(res);
    assert.strictEqual(body["errorType"], "CourseNotFound");
    assert.deepStrictEqual(body["fields"], { courseId: "ghost" });
  });

  it("a full course is a 409 problem with the course's capacity", async () => {
    const courseId = `full-${uid()}`;
    await post("define_course", { courseId, capacity: 1 });
    await post("subscribe", { studentId: `ann-${uid()}`, courseId });
    const res = await post("subscribe", { studentId: `bob-${uid()}`, courseId });
    assert.strictEqual(res.status, 409);
    const body = await json(res);
    assert.strictEqual(body["errorType"], "CourseFull");
    assert.deepStrictEqual(body["fields"], { courseId, capacity: 1 });
  });

  it("a student's fourth course is a 409 StudentAtLimit", async () => {
    const student = `cy-${uid()}`;
    const statuses: Array<number> = [];
    for (const n of [1, 2, 3, 4]) {
      const courseId = `c${n}-${uid()}`;
      await post("define_course", { courseId, capacity: 5 });
      statuses.push((await post("subscribe", { studentId: student, courseId })).status);
    }
    assert.deepStrictEqual(statuses, [201, 201, 201, 409]);
  });

  it("defining the same course twice is the framework's 409 conflict; a bad payload is a 400 problem", async () => {
    const courseId = `dup-${uid()}`;
    assert.strictEqual((await post("define_course", { courseId, capacity: 3 })).status, 201);
    const dup = await post("define_course", { courseId, capacity: 3 });
    assert.strictEqual(dup.status, 409);
    assert.strictEqual((await json(dup))["violationCode"], "IDEMPOTENCY_VIOLATION");

    const bad = await post("define_course", { courseId: "x", capacity: 0 });
    assert.strictEqual(bad.status, 400);
    const badBody = await json(bad);
    assert.strictEqual(badBody["detail"], "Invalid payload for command: define_course");
    assert.deepStrictEqual(badBody["errors"], [{ path: ["capacity"], message: "Expected a value greater than or equal to 1" }]);
  });

  it("a payload with several wrong fields reports all of them at once, and never the values sent", async () => {
    const res = await post("define_course", { courseId: 5, capacity: "SECRET-VALUE" });
    assert.strictEqual(res.status, 400);
    const text = await res.text();
    const body = JSON.parse(text) as Record<string, unknown>;
    assert.deepStrictEqual(body["errors"], [
      { path: ["courseId"], message: "Expected string" },
      { path: ["capacity"], message: "Expected number" }
    ]);
    assert.ok(!text.includes("SECRET-VALUE"), "the value that was sent is not echoed");
  });

  it("serves its own OpenAPI document - the one checked in at docs/api - and no docs page unless asked for", async () => {
    assert.deepStrictEqual(await json(await fetch(`${app.baseUrl}/openapi.json`)), JSON.parse(readFileSync(courseOpenApiFile, "utf8")));
    assert.strictEqual((await fetch(`${app.baseUrl}/docs`)).status, 404);
  });

  it("the documentation page is served when configured", async () => {
    const withDocs = await startCourseAppForTest(db.connInfo, { docs: { ui: "scalar" } });
    try {
      const res = await fetch(`${withDocs.baseUrl}/docs`);
      assert.strictEqual(res.status, 200);
      assert.match(res.headers.get("content-type") ?? "", /text\/html/);
    } finally {
      await withDocs.stop();
    }
  });

  it("a client derived from the API drives the same flow, and a refusal arrives as its typed problem", async () => {
    const courseId = `typed-${uid()}`;
    const program = Effect.gen(function* () {
      const client: any = yield* HttpApiClient.make(makeCourseApi(), { baseUrl: app.baseUrl });
      const defined = yield* client.commands.execute_define_course({ payload: { courseId, capacity: 1 }, query: {} });
      yield* client.commands.execute_subscribe({ payload: { studentId: `ann-${courseId}`, courseId }, query: {} });
      const refused = yield* Effect.flip(client.commands.execute_subscribe({ payload: { studentId: `bob-${courseId}`, courseId }, query: {} }));
      return { defined, refused };
    });
    const { defined, refused } = await Effect.runPromise(program.pipe(Effect.provide(FetchHttpClient.layer)) as Effect.Effect<any>);
    assert.strictEqual(defined.status, "CREATED");
    assert.strictEqual(refused.errorType, "CourseFull");
    assert.deepStrictEqual(refused.fields, { courseId, capacity: 1 });
  });

  // ---- step 4: read your own writes ----
  const getCourse = (courseId: string) => fetch(`${app.baseUrl}/api/courses/${courseId}`);

  it("?waitFor=course-seats-view answers once the view has the write, so ONE read is enough - every time", async () => {
    const courseId = `seats-${uid()}`;
    assert.strictEqual((await post("define_course", { courseId, capacity: 5 })).status, 201);
    for (const [n, name] of ["ann", "bob", "cy", "di"].entries()) {
      const student = `${name}-${uid()}`;
      const res = await fetch(`${app.baseUrl}/api/commands/subscribe?waitFor=course-seats-view`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ studentId: student, courseId })
      });
      assert.strictEqual(res.status, 201);
      assert.deepStrictEqual((await json(res))["view"], { name: "course-seats-view", caughtUp: true });
      // a single read, no retry loop, already reflects the subscription that just returned
      assert.deepStrictEqual(await json(await getCourse(courseId)), { courseId, capacity: 5, subscribers: n + 1, seatsLeft: 4 - n });
    }
  });

  it("a repeat subscription appended nothing: nothing to wait for, and the seats are not counted twice", async () => {
    const courseId = `repeat-${uid()}`;
    await post("define_course", { courseId, capacity: 3 });
    const student = `ann-${uid()}`; // a fresh student: the 3-course limit is per student across the whole test file
    const wait = () =>
      fetch(`${app.baseUrl}/api/commands/subscribe?waitFor=course-seats-view`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ studentId: student, courseId })
      });
    assert.strictEqual((await wait()).status, 201);
    const repeat = await wait();
    assert.strictEqual(repeat.status, 200);
    assert.deepStrictEqual((await json(repeat))["view"], { name: "course-seats-view", caughtUp: false, reason: "nothing_appended" });
    assert.strictEqual((await json(await getCourse(courseId)))["subscribers"], 1);
  });

  it("an unknown view is refused before the command runs: nothing is written", async () => {
    const courseId = `refused-${uid()}`;
    await post("define_course", { courseId, capacity: 3 });
    const student = `ann-${uid()}`;
    const res = await fetch(`${app.baseUrl}/api/commands/subscribe?waitFor=no-such-view`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ studentId: student, courseId })
    });
    assert.strictEqual(res.status, 400);
    assert.match(String((await json(res))["detail"]), /one of: course-seats-view/);
    // the subscription never happened: the same student can still take the course
    assert.strictEqual((await post("subscribe", { studentId: student, courseId })).status, 201);
  });

  it("reading an unknown course is the same 404 problem the write API uses", async () => {
    const res = await getCourse("ghost-course");
    assert.strictEqual(res.status, 404);
    const body = await json(res);
    assert.strictEqual(body["errorType"], "CourseNotFound");
    assert.deepStrictEqual(body["fields"], { courseId: "ghost-course" });
  });
});
