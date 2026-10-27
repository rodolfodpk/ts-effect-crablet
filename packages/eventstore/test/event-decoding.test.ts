import { describe, expect, test } from "bun:test";
import { Effect, Metric } from "effect";
import * as EventStoreMetrics from "@crablet/metrics-otel/EventStoreMetrics";
import { decodingErrorOf, describeIssues, EventDecodingFailure, reportDecodingError } from "../src/EventDecoding.ts";

describe("EventDecoding", () => {
  test("describeIssues names each issue's path, and only the message for the payload as a whole", () => {
    expect(describeIssues([{ path: [], message: "Expected an object" }, { path: ["items", 2, "amount"], message: "Missing key" }])).toBe(
      "Expected an object; Missing key at items.2.amount"
    );
  });

  test("reportDecodingError fails with the error and counts it by event type", async () => {
    const error = decodingErrorOf(new EventDecodingFailure("ED_Paid", [{ path: ["amount"], message: "Missing key" }]), { position: 7n, transactionId: "3" });
    expect(error.message).toBe("stored event ED_Paid at position 7 (transaction 3) cannot be read: Missing key at amount");
    const count = () =>
      Effect.runPromise(Metric.value(Metric.withAttributes(EventStoreMetrics.decodingFailures, { event_type: "ED_Paid" }))).then((m) => (m as unknown as { count: number }).count);
    const before = await count();
    expect(await Effect.runPromise(Effect.flip(reportDecodingError(error)))).toBe(error);
    expect(await count()).toBe(before + 1);
  });
});
