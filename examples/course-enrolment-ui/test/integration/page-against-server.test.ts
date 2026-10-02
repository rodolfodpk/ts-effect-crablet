// Runs under Node (Testcontainers). The page against the REAL course app on a real Postgres, without a browser.
//
// A tiny driver plays the part of Foldkit's runtime: it feeds a Message to the page's own `update`, runs every Command
// the update returns (the real Effects, with the real derived client and `fetch`), and feeds each result Message back,
// until nothing is left to run. What it ends with is the Model the page would be showing. `globalThis.location` is the
// base URL a browser would supply for the page's relative URLs.
//
// The seats view is held back 300 ms (the course app's demo knob) so that "waiting for the seat map" and "not waiting"
// give different answers, as they do in real life when the view lags.
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { Effect } from "effect";
import * as AsyncData from "foldkit/asyncData";
import { startTestDb, type TestDb } from "@crablet/test-support";
import { startCourseAppForTest, type RunningCourseApp } from "../../../course-enrolment-app/test/support/startCourseAppForTest.ts";
import { applyAppMigrations } from "../../../course-enrolment-app/test/support/applyAppMigrations.ts";
import { DefineCourse, Message, init, update, viewNote, type Model } from "../../src/main.ts";

const DELAY_MS = 300;
let db: TestDb;
let app: RunningCourseApp;

const setBaseUrl = (url: string): void => {
  (globalThis as { location?: unknown }).location = new URL(url);
};

before(async () => {
  db = await startTestDb();
  await applyAppMigrations(db.connInfo);
  app = await startCourseAppForTest(db.connInfo, {}, { viewDelayMs: DELAY_MS });
  setBaseUrl(app.baseUrl);
}, { timeout: 90_000 });
after(async () => {
  delete (globalThis as { location?: unknown }).location;
  await app.stop();
  await db.stop();
});

// #region driver
// Feed `messages` through the page one after another, running every Command to completion in between.
const drive = async (from: Model, ...messages: ReadonlyArray<Message>): Promise<Model> => {
  let model = from;
  const queue: Array<Message> = [...messages];
  while (queue.length > 0) {
    const result = update(model, queue.shift()!);
    model = result.model;
    for (const command of result.commands ?? []) queue.unshift((await Effect.runPromise(command.effect as Effect.Effect<Message>)) as Message);
  }
  return model;
};
// #endregion driver

const uid = () => crypto.randomUUID().slice(0, 8);
const typeInto = (...pairs: ReadonlyArray<Message>) => pairs;
const defineCourse = (model: Model, courseId: string, capacity: number) =>
  drive(
    model,
    ...typeInto(Message.ChangedDefineCourseId({ value: courseId }), Message.ChangedDefineCapacity({ value: String(capacity) })),
    Message.SubmittedDefineCourse()
  );
const subscribe = (model: Model, studentId: string, courseId: string) =>
  drive(
    model,
    ...typeInto(Message.ChangedSubscribeStudentId({ value: studentId }), Message.ChangedSubscribeCourseId({ value: courseId })),
    Message.SubmittedSubscribe()
  );

const lookupState = (model: Model) =>
  AsyncData.match(model.lookup, {
    onIdle: () => "idle",
    onLoading: () => "loading",
    onRefreshing: () => "loading",
    onFailure: (problem) => `problem:${problem._tag}`,
    onStale: ({ data }) => `${data.seatsLeft}/${data.capacity} (${data.subscribers})`,
    onSuccess: (data) => `${data.seatsLeft}/${data.capacity} (${data.subscribers})`
  });
const subscribeFailure = (model: Model) => AsyncData.match(model.subscribe.result, {
  onIdle: () => null, onLoading: () => null, onRefreshing: () => null, onStale: () => null, onSuccess: () => null,
  onFailure: (problem) => problem
});

describe("the page, driven against the real course app", () => {
  it("define a course and the read-back (after the write waited) shows it", { timeout: 30_000 }, async () => {
    const course = `c-${uid()}`;
    const model = await defineCourse(init().model, course, 3);
    assert.strictEqual(lookupState(model), "3/3 (0)");
    assert.ok(AsyncData.isSuccess(model.define.result));
  });

  it("with waiting on, the read after a subscription is right; with it off, it is stale - then right again once the view catches up", { timeout: 30_000 }, async () => {
    const course = `c-${uid()}`;
    let model = await defineCourse(init().model, course, 3);

    // waiting OFF: the answer comes back at once, and the read-back does not include the write
    model = await drive(model, Message.ToggledWaitForView());
    assert.strictEqual(model.waitForView, false);
    model = await subscribe(model, `ann-${uid()}`, course);
    assert.strictEqual(lookupState(model), "3/3 (0)", "stale: the view has not applied the subscription yet");

    // waiting ON: the answer comes back once the view has the write (and everything before it)
    model = await drive(model, Message.ToggledWaitForView());
    const started = Date.now();
    model = await subscribe(model, `bob-${uid()}`, course);
    assert.strictEqual(lookupState(model), "1/3 (2)", "right: both subscriptions are in the view");
    assert.ok(Date.now() - started >= DELAY_MS / 2, "the write really waited for the delayed view");
    const done = model.subscribe.result;
    assert.ok(AsyncData.isSuccess(done) && viewNote(done.data.outcome) === "The seat map had caught up when this answered.");
  });

  it("a repeat is 'already subscribed', and says nothing about the seat map (nothing was appended)", { timeout: 30_000 }, async () => {
    const course = `c-${uid()}`;
    const student = `ann-${uid()}`;
    let model = await defineCourse(init().model, course, 3);
    model = await subscribe(model, student, course);
    model = await subscribe(model, student, course);
    const done = model.subscribe.result;
    assert.ok(AsyncData.isSuccess(done));
    assert.deepStrictEqual([done.data.outcome.status, done.data.outcome.reason], ["IDEMPOTENT", "ALREADY_SUBSCRIBED"]);
    assert.strictEqual(viewNote(done.data.outcome), "");
  });

  it("every refusal arrives as the problem the page understands, with the fields it shows", { timeout: 60_000 }, async () => {
    const course = `c-${uid()}`;
    let model = await defineCourse(init().model, course, 1);
    model = await subscribe(model, `ann-${uid()}`, course);

    // a full course
    const full = await subscribe(model, `bob-${uid()}`, course);
    assert.deepStrictEqual(subscribeFailure(full), { _tag: "CourseFull", courseId: course, capacity: 1 });

    // a course that does not exist
    const ghost = `ghost-${uid()}`;
    const missing = await subscribe(model, `cy-${uid()}`, ghost);
    assert.deepStrictEqual(subscribeFailure(missing), { _tag: "CourseNotFound", courseId: ghost });

    // a student's fourth course
    const student = `di-${uid()}`;
    let busy = model;
    for (const n of [1, 2, 3]) {
      const id = `c${n}-${uid()}`;
      busy = await defineCourse(busy, id, 5);
      busy = await subscribe(busy, student, id);
    }
    const fifth = `c4-${uid()}`;
    busy = await defineCourse(busy, fifth, 5);
    busy = await subscribe(busy, student, fifth);
    assert.deepStrictEqual(subscribeFailure(busy), { _tag: "StudentAtLimit", studentId: student, limit: 3 });

    // defining a course twice is the framework's conflict
    const again = await defineCourse(model, course, 1);
    assert.ok(AsyncData.isFailure(again.define.result));
    const failure = AsyncData.match(again.define.result, {
      onIdle: () => null, onLoading: () => null, onRefreshing: () => null, onStale: () => null, onSuccess: () => null, onFailure: (p) => p
    });
    assert.strictEqual(failure?._tag, "Rejected");
  });

  it("a lookup of a course that was never defined is 'no such course'; of one just written without waiting, 'not in the seat map yet'", { timeout: 30_000 }, async () => {
    const ghost = `ghost-${uid()}`;
    let model = init().model;
    model = await drive(model, Message.ChangedLookupCourseId({ value: ghost }), Message.SubmittedLookup());
    assert.strictEqual(lookupState(model), "problem:CourseNotFound");

    model = await drive(model, Message.ToggledWaitForView());
    model = await defineCourse(model, `fresh-${uid()}`, 2);
    assert.strictEqual(lookupState(model), "problem:NotInSeatMapYet");
  });

  it("the page's own validation stops a capacity of 0 before any command; the derived client would refuse it too, naming the field", { timeout: 30_000 }, async () => {
    const model = await defineCourse(init().model, `c-${uid()}`, 0);
    assert.ok(AsyncData.isIdle(model.define.result), "no command was sent");
    assert.strictEqual(model.define.capacity._tag, "Invalid");

    // Bypass the form: the Command itself. The client checks the request against the API's own Schema before sending it.
    const answer = (await Effect.runPromise(DefineCourse({ courseId: `c-${uid()}`, capacity: 0, waitForView: true }).effect as Effect.Effect<Message>)) as {
      readonly _tag: string;
      readonly problem?: { readonly _tag: string; readonly detail?: string };
    };
    assert.strictEqual(answer._tag, "FailedDefineCourse");
    assert.strictEqual(answer.problem?._tag, "Mismatch");
    assert.match(answer.problem?.detail ?? "", /capacity/);
  });

  it("when the server cannot be reached the page says so", { timeout: 30_000 }, async () => {
    setBaseUrl("http://localhost:1/");
    try {
      const model = await drive(init().model, Message.ChangedLookupCourseId({ value: "anything" }), Message.SubmittedLookup());
      assert.strictEqual(lookupState(model), "problem:Unreachable");
    } finally {
      setBaseUrl(app.baseUrl);
    }
  });
});
