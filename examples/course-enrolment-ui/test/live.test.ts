// The live-update feed: what the page does with a ping, and the reconnecting stream (backoff, reset) against fake connections.
import { describe, expect, test } from "bun:test";
import { Duration, Effect, Stream } from "effect";
import * as AsyncData from "foldkit/asyncData";
import { Scene, Story } from "foldkit/test";
import { reconnectDelay, reconnecting } from "../src/api.ts";
import { FetchCourse, FetchCourses, Lookup, Message, feedNote, init, update, view, type Model } from "../src/main.ts";

expect.extend(Scene.sceneMatchers as never);

const start: Model = init().model;
const noCourses = Message.SucceededFetchCourses({ items: [], next: null, append: false });
const math = { courseId: "math", capacity: 3, subscribers: 1, seatsLeft: 2 };

describe("a ping from the feed", () => {
  test("reads the list again, from its first page, under the filter in effect", () => {
    Story.story(
      update,
      Story.given<Model>({ ...start, courses: { ...start.courses, applied: "ma", filter: "mathx" } }),
      Story.message(Message.ReceivedSeatMapPing()),
      Story.model((m: Model) => expect(m.feed).toBe("live")),
      Story.Command.expectExact(FetchCourses({ q: "ma", after: null, append: false, consistentWith: null })),
      Story.Command.resolve(FetchCourses, noCourses)
    );
  });

  test("also reads again the course on show", () => {
    Story.story(
      update,
      Story.given<Model>({ ...start, lookupCourseId: "math", lookup: Lookup.Success({ data: math }) }),
      Story.message(Message.ReceivedSeatMapPing()),
      Story.Command.expectExact(FetchCourses({ q: "", after: null, append: false, consistentWith: null }), FetchCourse({ courseId: "math", consistentWith: null })),
      Story.Command.resolve(FetchCourses, noCourses),
      Story.Command.resolve(FetchCourse, Message.SucceededFetchCourse({ course: math }))
    );
  });

  test("does not read a course the user has not looked up", () => {
    Story.story(
      update,
      Story.given<Model>({ ...start, lookupCourseId: "typed-but-not-submitted" }),
      Story.message(Message.ReceivedSeatMapPing()),
      Story.Command.expectExact(FetchCourses({ q: "", after: null, append: false, consistentWith: null })),
      Story.Command.resolve(FetchCourses, noCourses)
    );
  });

  test("losing the feed is shown, and nothing is read", () => {
    Story.story(
      update,
      Story.given<Model>({ ...start, feed: "live" }),
      Story.message(Message.LostSeatMapFeed()),
      Story.model((m: Model) => expect(m.feed).toBe("reconnecting")),
      Story.Command.expectNone()
    );
  });

  test("the page says whether it is live", () => {
    expect(feedNote("live")).toContain("Live");
    expect(feedNote("reconnecting")).toContain("reconnecting");
    expect(feedNote("connecting")).toContain("Connecting");
  });
});

describe("the page, with the feed", () => {
  test("shows the connection state, and a ping from another tab refreshes the list", () => {
    Scene.scene(
      { update, view },
      Scene.given<Model>(start),
      Scene.expect(Scene.text("Connecting for live updates...")).toExist(),
      Scene.Subscription.emit(Message.ReceivedSeatMapPing()),
      Scene.Command.resolve(FetchCourses, Message.SucceededFetchCourses({ items: [{ ...math }], next: null, append: false })),
      Scene.expect(Scene.text("Live: the list updates when anyone's write reaches the seat map.")).toExist(),
      Scene.expect(Scene.text("math: 2 of 3 seats left")).toExist()
    );
  });
});

describe("the backoff", () => {
  test("starts at half a second, doubles, and is capped at 30 seconds", () => {
    const ms = (n: number) => Duration.toMillis(reconnectDelay(n));
    expect([1, 2, 3, 4].map(ms)).toEqual([500, 1000, 2000, 4000]);
    expect(ms(7)).toBe(30_000);
    expect(ms(50)).toBe(30_000);
  });
});

describe("reconnecting", () => {
  // Each connection is a Stream: `pings` pings then it ends (or fails), as the server's lifetime limit or a dropped network does.
  const connections = (plan: ReadonlyArray<{ pings: number; fail?: boolean }>) => {
    let n = 0;
    const open = Stream.suspend(() => {
      const step = plan[n++] ?? { pings: 0 };
      const pings = Stream.fromIterable(Array.from({ length: step.pings }, () => "ping"));
      return step.fail ? pings.pipe(Stream.concat(Stream.fail("dropped"))) : pings;
    });
    return { open, opened: () => n };
  };
  const run = (plan: ReadonlyArray<{ pings: number; fail?: boolean }>, take: number) => {
    const delays: Array<number> = [];
    const c = connections(plan);
    const stream = reconnecting(c.open, () => "ping", () => "lost", (failures) => {
      delays.push(failures);
      return Duration.millis(1);
    });
    return Effect.runPromise(stream.pipe(Stream.take(take), Stream.runCollect)).then((out) => ({ out: [...out], delays, opened: c.opened() }));
  };

  test("a connection that ends is reported as lost and opened again", async () => {
    const { out, opened } = await run([{ pings: 2 }, { pings: 1 }], 6);
    expect(out).toEqual(["ping", "ping", "lost", "ping", "lost", "lost"]);
    expect(opened).toBeGreaterThanOrEqual(3);
  });

  test("a failing connection is treated like one that ended", async () => {
    const { out } = await run([{ pings: 1, fail: true }, { pings: 1 }], 5);
    expect(out).toEqual(["ping", "lost", "ping", "lost", "lost"]);
  });

  test("failures in a row count up; a ping resets the count", async () => {
    // connections 1 and 2 deliver nothing, 3 delivers a ping and ends, 4 and 5 deliver nothing
    const { delays } = await run([{ pings: 0 }, { pings: 0 }, { pings: 1 }, { pings: 0 }, { pings: 0 }], 9);
    expect(delays.slice(0, 5)).toEqual([1, 2, 1, 1, 2]);
  });
});
