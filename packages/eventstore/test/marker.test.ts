import { describe, expect, it } from "bun:test";
import { formatMarker, parseMarker } from "../src/Marker.ts";

describe("formatMarker", () => {
  it("is the transaction id and the position, joined by a colon", () => {
    expect(formatMarker({ transactionId: "7421", position: 98213n })).toBe("7421:98213");
  });
});

describe("parseMarker", () => {
  it("reads back what formatMarker wrote", () => {
    for (const marker of [
      { transactionId: "7421", position: 98213n },
      { transactionId: "1", position: 1n },
      { transactionId: "0", position: 0n }, // the start of the log: nothing to wait for
      { transactionId: "18446744073709551615", position: 9223372036854775807n } // the largest xid8 and the largest BIGINT
    ]) {
      expect(parseMarker(formatMarker(marker))).toEqual(marker);
    }
  });

  it("keeps the transaction id as text: an xid8 does not fit a JavaScript number", () => {
    expect(parseMarker("18446744073709551615:1")?.transactionId).toBe("18446744073709551615");
  });

  it("rejects anything that is not exactly two decimal numbers around one colon", () => {
    for (const raw of ["", ":", "1", "1:", ":1", "1:2:3", "a:1", "1:b", "0x10:1", "1:0x10", "1.5:1", "1:1.5", "-1:1", "1:-1", "+1:1", " 1:1", "1:1 ", "1: 1", "1e3:1", "１:1"]) {
      expect(parseMarker(raw), JSON.stringify(raw)).toBeNull();
    }
  });

  it("rejects leading zeros, so each marker has one spelling", () => {
    expect(parseMarker("007:1")).toBeNull();
    expect(parseMarker("7:001")).toBeNull();
    expect(parseMarker("0:0")).not.toBeNull();
  });

  it("rejects numbers the database cannot hold (xid8 above 2^64 - 1, BIGINT above 2^63 - 1)", () => {
    expect(parseMarker("18446744073709551616:1")).toBeNull();
    expect(parseMarker("1:9223372036854775808")).toBeNull();
    expect(parseMarker(`${"9".repeat(40)}:1`)).toBeNull();
  });
});
