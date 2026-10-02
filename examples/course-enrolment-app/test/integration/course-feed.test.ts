// Runs under Node (Testcontainers). GET /api/views/changes, the live-update feed: a write to a course makes the seats view move, the feed sends a
// ping whose cursor covers the write's own (lastTransactionId, lastPosition); a bad `views` is a 400; a connection ends after the maximum
// lifetime; a closed connection does not leak; stopping the app with a connection open is fast.
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { startTestDb, type TestDb } from "@crablet/test-support";
import * as ProgressCursor from "@crablet/event-poller/ProgressCursor";
import { applyAppMigrations } from "../support/applyAppMigrations.ts";
import { startCourseAppForTest, type RunningCourseApp } from "../support/startCourseAppForTest.ts";

let db: TestDb;
let app: RunningCourseApp;

before(async () => {
  db = await startTestDb();
  await applyAppMigrations(db.connInfo);
  app = await startCourseAppForTest(db.connInfo);
  // Once the view has progress the feed has something to open with (its response starts with that first frame); see "opens with".
  await waitUntilSeatsViewMoved(await define(app.baseUrl, "feed-seed"));
}, { timeout: 120_000 });
after(async () => {
  await db.stop();
});

interface Advanced { readonly view: string; readonly transactionId: string; readonly position: string }

// Opens the feed and yields its data frames as they arrive.
const openFeed = async (base: string, query = "?views=course-seats-view") => {
  const controller = new AbortController();
  const res = await fetch(`${base}/api/views/changes${query}`, { signal: controller.signal, headers: { Accept: "text/event-stream" } });
  const frames: Array<Advanced> = [];
  let ended = false;
  const reader = res.body?.getReader();
  const pump = (async () => {
    if (!reader) return;
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let i: number;
        while ((i = buffer.indexOf("\n\n")) >= 0) {
          const block = buffer.slice(0, i);
          buffer = buffer.slice(i + 2);
          const data = block.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).join("");
          if (data !== "") frames.push(JSON.parse(data) as Advanced);
        }
      }
    } catch {
      // aborted
    }
    ended = true;
  })();
  return { res, frames, close: () => controller.abort(), isEnded: () => ended, finished: pump };
};
const waitFor = async (check: () => boolean, ms = 10_000) => {
  const start = Date.now();
  while (!check() && Date.now() - start < ms) await new Promise((r) => setTimeout(r, 25));
};
async function define(base: string, courseId: string) {
  const res = await fetch(`${base}/api/commands/define_course`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ courseId, capacity: 2 }) });
  assert.strictEqual(res.status, 201);
  return (await res.json()) as { lastTransactionId: string; lastPosition: string };
}

// Waits until the seats view has applied the write (a held request, as a client would with ?waitFor).
async function waitUntilSeatsViewMoved(write: { lastTransactionId: string; lastPosition: string }) {
  const res = await fetch(`${app.baseUrl}/api/courses/feed-seed`);
  if (res.status === 200) return;
  await new Promise((r) => setTimeout(r, 200));
  return waitUntilSeatsViewMoved(write);
}

describe("GET /api/views/changes", () => {
  it("opens with where the view is now", { timeout: 30_000 }, async () => {
    const feed = await openFeed(app.baseUrl);
    try {
      await waitFor(() => feed.frames.length > 0);
      assert.strictEqual(feed.frames[0]!.view, "course-seats-view");
      assert.match(feed.frames[0]!.position, /^\d+$/);
    } finally {
      feed.close();
      await feed.finished;
    }
  });

  it("sends a ping whose cursor covers the write that moved the view", { timeout: 30_000 }, async () => {
    const feed = await openFeed(app.baseUrl);
    try {
      assert.strictEqual(feed.res.status, 200);
      assert.match(feed.res.headers.get("content-type") ?? "", /text\/event-stream/);
      const write = await define(app.baseUrl, `feed-${crypto.randomUUID().slice(0, 8)}`);
      const writeCursor = ProgressCursor.of(write.lastTransactionId, BigInt(write.lastPosition));
      await waitFor(() => feed.frames.some((f) => ProgressCursor.compare(ProgressCursor.of(f.transactionId, BigInt(f.position)), writeCursor) >= 0));
      const covering = feed.frames.find((f) => ProgressCursor.compare(ProgressCursor.of(f.transactionId, BigInt(f.position)), writeCursor) >= 0);
      assert.ok(covering, "a ping covering the write arrived");
      assert.strictEqual(covering.view, "course-seats-view");
    } finally {
      feed.close();
      await feed.finished;
    }
  });

  it("an unknown or empty `views` is a 400 problem", { timeout: 30_000 }, async () => {
    for (const query of ["?views=nope", "?views=", "?views=course-seats-view,nope"]) {
      const res = await fetch(`${app.baseUrl}/api/views/changes${query}`);
      assert.strictEqual(res.status, 400, query);
      assert.match(res.headers.get("content-type") ?? "", /application\/problem\+json/);
    }
  });

  it("two connections each get the ping; one closing does not affect the other", { timeout: 30_000 }, async () => {
    const a = await openFeed(app.baseUrl);
    const b = await openFeed(app.baseUrl);
    try {
      await define(app.baseUrl, `feed-${crypto.randomUUID().slice(0, 8)}`);
      await waitFor(() => a.frames.length > 0 && b.frames.length > 0);
      assert.ok(a.frames.length > 0 && b.frames.length > 0, "both received");
      a.close();
      await a.finished;
      const before = b.frames.length;
      await define(app.baseUrl, `feed-${crypto.randomUUID().slice(0, 8)}`);
      await waitFor(() => b.frames.length > before);
      assert.ok(b.frames.length > before, "the other still receives");
    } finally {
      a.close();
      b.close();
      await Promise.all([a.finished, b.finished]);
    }
  });

  it("the server ends a connection after the maximum lifetime", { timeout: 30_000 }, async () => {
    const shortApp = await startCourseAppForTest(db.connInfo, { maxFeedLifetime: "600 millis" });
    try {
      const feed = await openFeed(shortApp.baseUrl);
      await waitFor(() => feed.isEnded(), 5_000);
      assert.ok(feed.isEnded(), "the stream ended on its own");
      feed.close();
    } finally {
      await shortApp.stop();
    }
  });

  it("stopping the app with a connection open is quick", { timeout: 30_000 }, async () => {
    const other = await startCourseAppForTest(db.connInfo);
    const feed = await openFeed(other.baseUrl);
    const started = Date.now();
    await other.stop();
    const took = Date.now() - started;
    feed.close();
    await feed.finished;
    assert.ok(took < 5_000, `stop took ${took} ms`);
  });
});

after(async () => {
  await app.stop();
});
