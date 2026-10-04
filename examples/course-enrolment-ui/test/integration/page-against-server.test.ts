// Runs under Node (Testcontainers). The page against the REAL course app on a real Postgres, without a browser.
//
// A tiny driver plays the part of Foldkit's runtime: it feeds a Message to the page's own `update`, runs every Command
// the update returns (the real Effects, with the real derived client and `fetch`), and feeds each result Message back,
// until nothing is left to run. What it ends with is the Model the page would be showing. `globalThis.location` is the
// base URL a browser would supply for the page's relative URLs.
//
// The seats view is held back 300 ms (the course app's demo knob) so that a read-back WITH the write's marker (the server waits for the seat
// map) and one WITHOUT it give different answers, as they do in real life when the view lags.
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { Effect, Fiber, Stream } from "effect";
import * as AsyncData from "foldkit/asyncData";
import { startTestDb, type TestDb } from "@crablet/test-support";
import { startCourseAppForTest, type RunningCourseApp } from "../../../course-enrolment-app/test/support/startCourseAppForTest.ts";
import { applyAppMigrations } from "../../../course-enrolment-app/test/support/applyAppMigrations.ts";
import { Client } from "pg";
import { DefineCourse, Message, init, readBackNote, subscriptions, update, type Model } from "../../src/main.ts";

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
  it("define a course and the read-back (with the write's marker) shows it", { timeout: 30_000 }, async () => {
    const course = `c-${uid()}`;
    const model = await defineCourse(init().model, course, 3);
    assert.strictEqual(lookupState(model), "3/3 (0)");
    assert.ok(AsyncData.isSuccess(model.define.result));
  });

  it("with the marker, the read after a subscription is right; without it, it is stale - then right again once the view catches up", { timeout: 30_000 }, async () => {
    const course = `c-${uid()}`;
    let model = await defineCourse(init().model, course, 3);

    // marker OFF: the write answers at once, and the read-back carries nothing, so it does not include the write
    model = await drive(model, Message.ToggledReadWithMarker());
    assert.strictEqual(model.readWithMarker, false);
    model = await subscribe(model, `ann-${uid()}`, course);
    assert.strictEqual(lookupState(model), "3/3 (0)", "stale: the view has not applied the subscription yet");
    assert.ok(AsyncData.isSuccess(model.subscribe.result) && model.subscribe.result.data.readBack === "eventual");

    // marker ON: the read-back carries the write's marker, so the server answers it only once the view has the write (and everything before it)
    model = await drive(model, Message.ToggledReadWithMarker());
    const started = Date.now();
    model = await subscribe(model, `bob-${uid()}`, course);
    assert.strictEqual(lookupState(model), "1/3 (2)", "right: both subscriptions are in the view");
    assert.ok(Date.now() - started >= DELAY_MS / 2, "the read really waited for the delayed view");
    const done = model.subscribe.result;
    assert.ok(AsyncData.isSuccess(done) && done.data.readBack === "with_marker");
    assert.ok(AsyncData.isSuccess(done) && readBackNote(done.data.readBack) === "Read back with this write's marker, so the numbers below include it.");
  });

  it("a repeat is 'already subscribed' and has no marker (nothing was appended), so the page reads back with `latest`", { timeout: 30_000 }, async () => {
    const course = `c-${uid()}`;
    const student = `ann-${uid()}`;
    let model = await defineCourse(init().model, course, 3);
    model = await subscribe(model, student, course);
    model = await subscribe(model, student, course);
    const done = model.subscribe.result;
    assert.ok(AsyncData.isSuccess(done));
    assert.deepStrictEqual([done.data.outcome.status, done.data.outcome.reason, done.data.outcome.marker], ["IDEMPOTENT", "ALREADY_SUBSCRIBED", null]);
    assert.strictEqual(done.data.readBack, "latest");
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

  it("a lookup of a course that was never defined is 'no such course'; of one just written without the marker, 'not in the seat map yet'", { timeout: 30_000 }, async () => {
    const ghost = `ghost-${uid()}`;
    let model = init().model;
    model = await drive(model, Message.ChangedLookupCourseId({ value: ghost }), Message.SubmittedLookup());
    assert.strictEqual(lookupState(model), "problem:CourseNotFound");

    model = await drive(model, Message.ToggledReadWithMarker());
    model = await defineCourse(model, `fresh-${uid()}`, 2);
    assert.strictEqual(lookupState(model), "problem:NotInSeatMapYet");
  });

  it("the page's own validation stops a capacity of 0 before any command; the derived client would refuse it too, naming the field", { timeout: 30_000 }, async () => {
    const model = await defineCourse(init().model, `c-${uid()}`, 0);
    assert.ok(AsyncData.isIdle(model.define.result), "no command was sent");
    assert.strictEqual(model.define.capacity._tag, "Invalid");

    // Bypass the form: the Command itself. The client checks the request against the API's own Schema before sending it.
    const answer = (await Effect.runPromise(DefineCourse({ courseId: `c-${uid()}`, capacity: 0 }).effect as Effect.Effect<Message>)) as {
      readonly _tag: string;
      readonly problem?: { readonly _tag: string; readonly detail?: string };
    };
    assert.strictEqual(answer._tag, "FailedDefineCourse");
    assert.strictEqual(answer.problem?._tag, "Mismatch");
    assert.match(answer.problem?.detail ?? "", /capacity/);
  });

  it("the course list: loaded at startup, reloaded after a write, filtered, paged with More, and a click opens a course", { timeout: 90_000 }, async () => {
    const tag = uid();
    const shown = (model: Model) =>
      AsyncData.match(model.courses.result, {
        onIdle: () => [] as ReadonlyArray<string>,
        onLoading: () => [] as ReadonlyArray<string>,
        onRefreshing: () => [] as ReadonlyArray<string>,
        onFailure: () => [] as ReadonlyArray<string>,
        onStale: ({ data }) => data.items.map((c) => c.courseId),
        onSuccess: (data) => data.items.map((c) => c.courseId)
      });
    const next = (model: Model) => (AsyncData.isSuccess(model.courses.result) ? model.courses.result.data.next : "not loaded");

    // 22 courses (more than one page of 20), the first 21 read back without the marker, the last with it
    let model = await drive(init().model, Message.ToggledReadWithMarker());
    for (let n = 1; n <= 21; n++) model = await defineCourse(model, `list-${tag}-${String(n).padStart(2, "0")}`, 2);
    model = await drive(model, Message.ToggledReadWithMarker());
    model = await defineCourse(model, `list-${tag}-22`, 2);

    // after the write read back with its marker the list was reloaded: page one (20 courses of this test's, in id order) and a cursor
    model = await drive(model, Message.ChangedCourseFilter({ value: `list-${tag}` }), Message.SubmittedCourseFilter());
    assert.strictEqual(shown(model).length, 20);
    assert.ok(next(model) !== null && next(model) !== "not loaded", "there is a second page");
    assert.deepStrictEqual(shown(model), [...shown(model)].sort());

    // More appends the rest, and the whole list is every course exactly once
    model = await drive(model, Message.ClickedMoreCourses());
    assert.strictEqual(shown(model).length, 22);
    assert.strictEqual(new Set(shown(model)).size, 22);
    assert.strictEqual(next(model), null);

    // a narrower filter starts again from the first page
    model = await drive(model, Message.ChangedCourseFilter({ value: `list-${tag}-2` }), Message.SubmittedCourseFilter());
    assert.deepStrictEqual(shown(model), [`list-${tag}-20`, `list-${tag}-21`, `list-${tag}-22`]);

    // a click opens the course in the lookup
    model = await drive(model, Message.ClickedCourse({ courseId: `list-${tag}-22` }));
    assert.strictEqual(lookupState(model), "2/2 (0)");
  });

  // The seat map cannot move while another transaction is open (the views only read below the oldest one), so a read-back that carries a write's
  // marker waits for the server's whole default timeout and is refused with a 503. The page must turn that real answer into its own problem.
  it("a read-back the seat map cannot serve in time is the 503 the page understands, and the write itself still succeeded", { timeout: 40_000 }, async () => {
    const holder = new Client({ host: db.connInfo.host, port: db.connInfo.port, database: db.connInfo.database, user: db.connInfo.username, password: db.connInfo.password });
    await holder.connect();
    try {
      await holder.query("BEGIN");
      await holder.query("SELECT pg_current_xact_id()");
      const model = await defineCourse(init().model, `held-${uid()}`, 3);
      assert.ok(AsyncData.isSuccess(model.define.result), "the write committed");
      assert.strictEqual(lookupState(model), "problem:SeatMapBehind");
      assert.ok(AsyncData.isSuccess(model.define.result) && model.define.result.data.readBack === "with_marker");
    } finally {
      await holder.query("COMMIT").catch(() => undefined);
      await holder.end();
    }
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

  // The two-tab demonstration: tab B has only the page's own live-update subscription (the real stream, the real server). Tab A writes; B is
  // never asked to reload, and its list gets the course because the feed pinged it and its `update` read the list again.
  it("a write in one tab shows up in another through the live feed", { timeout: 40_000 }, async () => {
    const course = `0-${uid()}`; // sorts first, so it is on the list's first page
    let tabB = await drive(init().model);
    const listed = (m: Model) => AsyncData.isSuccess(m.courses.result) && m.courses.result.data.items.some((c) => c.courseId === course);
    assert.ok(!listed(tabB));

    const fiber = Effect.runFork(
      subscriptions.seatMapFeed.dependenciesToStream({ enabled: true }).pipe(
        Stream.runForEach((message) => Effect.promise(async () => { tabB = await drive(tabB, message as Message); }))
      ) as Effect.Effect<void>
    );
    try {
      await defineCourse(init().model, course, 4); // tab A
      const start = Date.now();
      while (!listed(tabB) && Date.now() - start < 15_000) await new Promise((r) => setTimeout(r, 100));
      assert.ok(listed(tabB), "tab B's list has the course without B doing anything");
      assert.strictEqual(tabB.feed, "live");
    } finally {
      await Effect.runPromise(Fiber.interrupt(fiber));
    }
  });
});
