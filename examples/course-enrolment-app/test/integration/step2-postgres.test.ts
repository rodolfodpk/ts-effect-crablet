// Runs under Node (Testcontainers). Tutorial step 2 against a real Postgres: the same commands, now with real races.
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { startTestDb, type TestDb } from "@crablet/test-support";
import { runStep2 } from "../../src/step2Demo.ts";

let db: TestDb;
before(async () => {
  db = await startTestDb();
}, { timeout: 60_000 });
after(async () => {
  await db.stop();
});

describe("tutorial step 2: the same commands against Postgres", () => {
  it("two students racing for the last seat: exactly one is subscribed, the other gets CourseFull", async () => {
    const summary = await runStep2(db.connInfo);
    assert.deepStrictEqual([...summary.lastSeat].sort(), ["CourseFull", "subscribed"]);
  });

  it("a student's fourth course is refused with StudentAtLimit", async () => {
    const summary = await runStep2(db.connInfo);
    assert.deepStrictEqual(summary.studentLimit, ["subscribed", "subscribed", "subscribed", "StudentAtLimit"]);
  });

  it("the demo can be run again against the same database (ids are unique per run)", async () => {
    await runStep2(db.connInfo);
    await runStep2(db.connInfo);
  });
});
