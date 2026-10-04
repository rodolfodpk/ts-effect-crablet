import { describe, expect, it } from "bun:test";
import {
  decodeTransactionCursor,
  defaultPageSize,
  encodeTransactionCursor,
  maxPageSize,
  parseLimit
} from "../src/api/TransactionPaging.ts";

describe("parseLimit", () => {
  it("is the default when absent", () => {
    expect(parseLimit(undefined)).toBe(defaultPageSize);
  });

  it("accepts a whole number from 1 to the maximum", () => {
    expect(parseLimit("1")).toBe(1);
    expect(parseLimit(String(maxPageSize))).toBe(maxPageSize);
  });

  it("rejects zero, too large, negative, fractional and non-numeric values", () => {
    for (const raw of ["0", String(maxPageSize + 1), "-1", "1.5", "abc", "", " 5", "5 ", "1e2"]) {
      expect(parseLimit(raw)).toBeNull();
    }
  });
});

describe("transaction cursor", () => {
  const key = { occurredAt: "2026-10-03 12:00:00.123456+00", eventPosition: "42", transactionId: "deposit-1" };

  it("round-trips, keeping the timestamp's microseconds", () => {
    expect(decodeTransactionCursor(encodeTransactionCursor(key))).toEqual(key);
  });

  it("is opaque text safe to put in a query string", () => {
    expect(encodeTransactionCursor(key)).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("round-trips ids with unusual characters", () => {
    const odd = { ...key, transactionId: "a b/c?d=e&fé|-from" };
    expect(decodeTransactionCursor(encodeTransactionCursor(odd))).toEqual(odd);
  });

  it("accepts the timestamp forms Postgres prints, with whole or partial seconds and a short or long offset", () => {
    for (const occurredAt of ["2026-10-03 12:00:00+00", "2026-10-03 12:00:00.5+02", "2026-10-03 12:00:00.123456-05:30"]) {
      const cursor = encodeTransactionCursor({ ...key, occurredAt });
      expect(decodeTransactionCursor(cursor)).toEqual({ ...key, occurredAt });
    }
  });

  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");

  it("rejects text that is not a cursor", () => {
    for (const raw of ["", "not a cursor", "!!!", encode("a string"), encode([1, 2]), encode({}), Buffer.from("{").toString("base64url")]) {
      expect(decodeTransactionCursor(raw)).toBeNull();
    }
  });

  it("rejects a cursor whose parts would make Postgres fail the cast (that must be a 400, not a 500)", () => {
    expect(decodeTransactionCursor(encode({ o: "yesterday", p: "1", t: "x" }))).toBeNull();
    expect(decodeTransactionCursor(encode({ o: key.occurredAt, p: "-1", t: "x" }))).toBeNull();
    expect(decodeTransactionCursor(encode({ o: key.occurredAt, p: "1.5", t: "x" }))).toBeNull();
    expect(decodeTransactionCursor(encode({ o: key.occurredAt, p: "9223372036854775808", t: "x" }))).toBeNull();
    expect(decodeTransactionCursor(encode({ o: key.occurredAt, p: 1, t: "x" }))).toBeNull();
    expect(decodeTransactionCursor(encode({ o: key.occurredAt, p: "1", t: 7 }))).toBeNull();
  });

  it("rejects an oversized cursor", () => {
    expect(decodeTransactionCursor(encodeTransactionCursor({ ...key, transactionId: "x".repeat(2000) }))).toBeNull();
  });
});
