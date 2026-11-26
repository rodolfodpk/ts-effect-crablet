// The live feed's request parsing and its declaration, in memory (the stream itself: examples/course-enrolment-app/test/integration/course-feed.test.ts).
import { describe, expect, test } from "bun:test";
import { liveFeedGroup } from "../src/LiveFeedApi.ts";
import { parseFeedViews } from "../src/LiveFeedLive.ts";

const known = new Set(["seats", "enrolments"]);

describe("parseFeedViews", () => {
  test("names one or more known views, trimmed, empty entries dropped", () => {
    expect(parseFeedViews("seats", known)).toEqual(new Set(["seats"]));
    expect(parseFeedViews(" seats , enrolments ,", known)).toEqual(new Set(["seats", "enrolments"]));
  });

  test("nothing named, or any unknown name, is refused", () => {
    expect(parseFeedViews("", known)).toBeNull();
    expect(parseFeedViews(" , ", known)).toBeNull();
    expect(parseFeedViews("seats,typo", known)).toBeNull();
  });
});

describe("liveFeedGroup", () => {
  test("is declared under the name the application picks, with the one endpoint", () => {
    const group = liveFeedGroup("courseFeed");
    expect(group.identifier).toBe("courseFeed");
    expect(Object.keys(group.endpoints)).toEqual(["viewChanges"]);
  });
});
