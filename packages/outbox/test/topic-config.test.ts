import { describe, expect, test } from "bun:test";
import { defineTopic } from "../src/TopicConfig.ts";
import { makeLogPublisher } from "../src/OutboxPublisher.ts";

const kafka = makeLogPublisher("kafka");
const webhook = makeLogPublisher("webhook");

describe("defineTopic", () => {
  test("takes the publishers themselves, as assignments", () => {
    const config = defineTopic("orders", { publishers: [kafka, webhook] });
    expect(config.topic).toBe("orders");
    expect(config.publishers).toEqual([{ publisher: kafka }, { publisher: webhook }]);
  });

  test("preserves full assignment objects with per-publisher overrides", () => {
    const config = defineTopic("orders", {
      publishers: [{ publisher: kafka, pollingIntervalMs: 200 }, webhook]
    });
    expect(config.publishers).toEqual([{ publisher: kafka, pollingIntervalMs: 200 }, { publisher: webhook }]);
  });

  test("fills EventSelection defaults when omitted", () => {
    const config = defineTopic("orders", { publishers: [] });
    expect(config.eventTypes.size).toBe(0);
    expect(config.requiredTags.size).toBe(0);
  });

  test("carries provided EventSelection fields", () => {
    const config = defineTopic("orders", {
      eventTypes: new Set(["OrderPlaced"]),
      publishers: []
    });
    expect([...config.eventTypes]).toEqual(["OrderPlaced"]);
  });
});
