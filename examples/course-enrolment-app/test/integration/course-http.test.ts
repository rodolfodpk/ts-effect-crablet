// Runs under Node (Testcontainers). Tutorial step 3: the API over real HTTP against a real Postgres.
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Effect } from "effect";
import { HttpApiClient } from "effect/http-api";
import { FetchHttpClient } from "effect/http";
import { startTestDb, type TestDb } from "@crablet/test-support";
import { startCourseAppForTest, type RunningCourseApp } from "../support/startCourseAppForTest.ts";
import { makeCourseApi } from "../../src/CourseApp.ts";
import { courseOpenApiFile } from "../../src/api/CourseOpenApi.ts";

let db: TestDb;
let app: RunningCourseApp;
before(async () => {
  db = await startTestDb();
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

    assert.strictEqual((await post("subscribe", { studentId: "ann", courseId })).status, 201);
    const repeat = await post("subscribe", { studentId: "ann", courseId });
    assert.strictEqual(repeat.status, 200);
    assert.strictEqual((await json(repeat)).status, "IDEMPOTENT");
  });

  it("an unknown course is a 404 problem naming the error and its fields", async () => {
    const res = await post("subscribe", { studentId: "ann", courseId: "ghost" });
    assert.strictEqual(res.status, 404);
    assert.strictEqual(res.headers.get("content-type"), "application/problem+json");
    const body = await json(res);
    assert.strictEqual(body["errorType"], "CourseNotFound");
    assert.deepStrictEqual(body["fields"], { courseId: "ghost" });
  });

  it("a full course is a 409 problem with the course's capacity", async () => {
    const courseId = `full-${uid()}`;
    await post("define_course", { courseId, capacity: 1 });
    await post("subscribe", { studentId: "ann", courseId });
    const res = await post("subscribe", { studentId: "bob", courseId });
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
    assert.strictEqual((await json(bad))["detail"], "Invalid payload for command: define_course");
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
      const defined = yield* client.commands.execute_define_course({ payload: { courseId, capacity: 1 } });
      yield* client.commands.execute_subscribe({ payload: { studentId: "ann", courseId } });
      const refused = yield* Effect.flip(client.commands.execute_subscribe({ payload: { studentId: "bob", courseId } }));
      return { defined, refused };
    });
    const { defined, refused } = await Effect.runPromise(program.pipe(Effect.provide(FetchHttpClient.layer)) as Effect.Effect<any>);
    assert.strictEqual(defined.status, "CREATED");
    assert.strictEqual(refused.errorType, "CourseFull");
    assert.deepStrictEqual(refused.fields, { courseId, capacity: 1 });
  });
});
