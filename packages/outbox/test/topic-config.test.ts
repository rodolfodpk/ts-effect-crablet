import { describe, expect, test } from "bun:test";
import { topicConfigOf } from "../src/TopicConfig.ts";

describe("topicConfigOf", () => {
  test("normalizes plain publisher name strings into assignments", () => {
    const config = topicConfigOf("orders", { publishers: ["kafka", "webhook"] });
    expect(config.topic).toBe("orders");
    expect(config.publishers).toEqual([{ name: "kafka" }, { name: "webhook" }]);
  });

  test("preserves full assignment objects with per-publisher overrides", () => {
    const config = topicConfigOf("orders", {
      publishers: [{ name: "kafka", pollingIntervalMs: 200 }, "webhook"]
    });
    expect(config.publishers).toEqual([{ name: "kafka", pollingIntervalMs: 200 }, { name: "webhook" }]);
  });

  test("fills EventSelection defaults when omitted", () => {
    const config = topicConfigOf("orders", { publishers: [] });
    expect(config.eventTypes.size).toBe(0);
    expect(config.requiredTags.size).toBe(0);
  });

  test("carries provided EventSelection fields", () => {
    const config = topicConfigOf("orders", {
      eventTypes: new Set(["OrderPlaced"]),
      publishers: []
    });
    expect([...config.eventTypes]).toEqual(["OrderPlaced"]);
  });
});
