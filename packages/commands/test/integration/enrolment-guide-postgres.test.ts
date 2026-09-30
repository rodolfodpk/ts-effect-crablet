// Runs under Node (Testcontainers). The DCB guide's enrolment example against real Postgres; every race
// uses a barrier in `prepare`, so all racers have LOADED before any of them appends.
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { Deferred, Effect, Redacted, Ref } from "effect";
import { startTestDb, type TestDb } from "@crablet/test-support";
import { EventStore } from "@crablet/eventstore";
import { Conflict } from "@crablet/eventstore/AppendErrors";
import * as Crablet from "../../src/Crablet.ts";
import { CommandExecutor } from "../../src/CommandExecutor.ts";
import {
  CourseDefined,
  CourseFull,
  CourseModel,
  StudentAtLimit,
  StudentModel,
  StudentSubscribed,
  subscribeWith
} from "../support/enrolment.ts";

let db: TestDb;
before(async () => {
  db = await startTestDb();
}, { timeout: 60_000 });
after(async () => {
  await db.stop();
});

const AppLive = () =>
  Crablet.layer({
    host: db.connInfo.host,
    port: db.connInfo.port,
    database: db.connInfo.database,
    username: db.connInfo.username,
    password: Redacted.make(db.connInfo.password)
  });
const run = <A, E>(e: Effect.Effect<A, E, any>) => Effect.runPromise(Effect.provide(e, AppLive()) as Effect.Effect<A, E, never>);

const barrier = (parties: number) =>
  Effect.gen(function* () {
    const arrived = yield* Ref.make(0);
    const gate = yield* Deferred.make<void>();
    return Effect.gen(function* () {
      if ((yield* Ref.updateAndGet(arrived, (n) => n + 1)) >= parties) yield* Deferred.succeed(gate, undefined);
      yield* Deferred.await(gate);
    });
  });

const uid = () => crypto.randomUUID().slice(0, 8);
const defineCourse = (courseId: string, capacity: number) =>
  Effect.flatMap(EventStore, (es) => es.append([CourseDefined({ courseId, capacity })]));
const subscribed = (studentId: string, courseId: string) =>
  Effect.flatMap(EventStore, (es) => es.append([StudentSubscribed({ studentId, courseId })]));
const subscribersOf = (courseId: string) =>
  Effect.flatMap(EventStore, (es) => Effect.map(CourseModel.of({ id: courseId }).load(es), (l) => l.state.subscribers));
const coursesOf = (studentId: string) =>
  Effect.flatMap(EventStore, (es) => Effect.map(StudentModel.of({ id: studentId }).load(es), (l) => l.state.courses.length));
const errorOf = (exit: any) => exit.cause?.reasons?.find((r: any) => r._tag === "Fail")?.error;
const exitAll = (effects: ReadonlyArray<Effect.Effect<any, any, any>>) =>
  Effect.all(effects.map((e) => Effect.exit(e)), { concurrency: effects.length });

describe("enrolment against Postgres", () => {
  it("the LAST seat in a course: two different students race, exactly one gets it", async () => {
    const course = `c-${uid()}`;
    const [ann, bob] = [`ann-${uid()}`, `bob-${uid()}`];
    const r = await run(
      Effect.gen(function* () {
        yield* defineCourse(course, 2);
        yield* subscribed(`early-${uid()}`, course); // one seat taken, one left
        const cmd = subscribeWith({ wait: yield* barrier(2) });
        const executor = yield* CommandExecutor;
        const exits = yield* exitAll([
          executor.run(cmd, { studentId: ann, courseId: course }),
          executor.run(cmd, { studentId: bob, courseId: course })
        ]);
        return { exits, subscribers: yield* subscribersOf(course) };
      })
    );
    assert.equal(r.exits.filter((e) => e._tag === "Success").length, 1);
    assert.ok(errorOf(r.exits.find((e) => e._tag === "Failure")) instanceof CourseFull, "the loser re-decided and found the course full");
    assert.equal(r.subscribers, 2, "capacity 2 was never exceeded");
  });

  it("a student's LAST slot: one student racing into two different courses, exactly one succeeds", async () => {
    const [a, b, c, d] = [1, 2, 3, 4].map((n) => `c${n}-${uid()}`);
    const student = `s-${uid()}`;
    const r = await run(
      Effect.gen(function* () {
        for (const course of [a, b, c, d]) yield* defineCourse(course, 10);
        yield* subscribed(student, a);
        yield* subscribed(student, b); // two of three used
        const cmd = subscribeWith({ wait: yield* barrier(2) });
        const executor = yield* CommandExecutor;
        const exits = yield* exitAll([
          executor.run(cmd, { studentId: student, courseId: c }),
          executor.run(cmd, { studentId: student, courseId: d })
        ]);
        return { exits, courses: yield* coursesOf(student) };
      })
    );
    assert.equal(r.exits.filter((e) => e._tag === "Success").length, 1);
    assert.ok(errorOf(r.exits.find((e) => e._tag === "Failure")) instanceof StudentAtLimit);
    assert.equal(r.courses, 3, "the limit of 3 was never exceeded");
  });

  it("unrelated enrolments (different student AND different course) never conflict, retries off", async () => {
    const [c1, c2] = [`c-${uid()}`, `c-${uid()}`];
    const exits = await run(
      Effect.gen(function* () {
        yield* defineCourse(c1, 5);
        yield* defineCourse(c2, 5);
        const cmd = subscribeWith({ wait: yield* barrier(2), retries: 0 });
        const executor = yield* CommandExecutor;
        return yield* exitAll([
          executor.run(cmd, { studentId: `s1-${uid()}`, courseId: c1 }),
          executor.run(cmd, { studentId: `s2-${uid()}`, courseId: c2 })
        ]);
      })
    );
    assert.deepEqual(exits.map((e) => e._tag), ["Success", "Success"]);
  });

  it("two students into the same roomy course, retries off: the shared course IS in both boundaries (one Conflict); with retries both get in", async () => {
    const race = (retries: number) =>
      run(
        Effect.gen(function* () {
          const course = `c-${uid()}`;
          yield* defineCourse(course, 10);
          const cmd = subscribeWith({ wait: yield* barrier(2), retries });
          const executor = yield* CommandExecutor;
          const exits = yield* exitAll([
            executor.run(cmd, { studentId: `s1-${uid()}`, courseId: course }),
            executor.run(cmd, { studentId: `s2-${uid()}`, courseId: course })
          ]);
          return { exits, subscribers: yield* subscribersOf(course) };
        })
      );
    const strict = await race(0);
    assert.equal(strict.exits.filter((e) => e._tag === "Success").length, 1);
    assert.ok(errorOf(strict.exits.find((e) => e._tag === "Failure")) instanceof Conflict);
    const retried = await race(3);
    assert.deepEqual(retried.exits.map((e) => e._tag), ["Success", "Success"]);
    assert.equal(retried.subscribers, 2);
  });
});
