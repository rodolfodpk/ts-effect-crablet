// Runs under Bun (`bun test` - see package.json's test:unit script) - see NOTES.md for why the
// test suite is split across two runners. `bun:test`'s API (`describe`/`test`/`expect(...).toBe(...)`)
// is deliberately Jest/Vitest-shaped - if you're used to those, this file will feel immediate.
// Contrast with the Postgres-backed test files (e.g. eventstore/test/leader-election.test.ts),
// which use Node's built-in `node:test` runner instead: `describe`/`it` + `node:assert/strict`'s
// `assert.strictEqual(...)` rather than a fluent `expect` chain - a more minimal, no-dependency
// API, chosen there only because `@testcontainers/postgresql` doesn't work under Bun (see
// NOTES.md), not because it's preferred in general. Pure, fast, no-Postgres-needed tests like this
// one always go under Bun; anything hitting a real database goes under Node.
import { describe, expect, test } from "bun:test";
import { decodePayload, encodePayload, isWildcard, shouldWake } from "../src/NotifyPayload.ts";

describe("notify payload codec (parity with PostgresNotifyPayload.java)", () => {
  test("empty types -> wildcard", () => {
    expect(encodePayload(new Set(), new Set())).toBe("*");
  });

  test("types only, no tags", () => {
    expect(encodePayload(new Set(["Beta", "Alpha"]), new Set())).toBe("Alpha,Beta");
  });

  test("types and tag keys", () => {
    expect(encodePayload(new Set(["WalletOpened"]), new Set(["wallet_id", "amount"]))).toBe(
      "WalletOpened|amount,wallet_id"
    );
  });

  test("over-length payload degrades to types-only", () => {
    const manyTagKeys = new Set(Array.from({ length: 2000 }, (_, i) => `tag_key_${i}`));
    const result = encodePayload(new Set(["A", "B"]), manyTagKeys);
    expect(result).toBe("A,B");
  });

  test("over-length even without tags degrades to wildcard", () => {
    const manyTypes = new Set(Array.from({ length: 2000 }, (_, i) => `SomeVeryLongEventTypeName_${i}`));
    const result = encodePayload(manyTypes, new Set());
    expect(result).toBe("*");
  });

  test("isWildcard", () => {
    expect(isWildcard(null)).toBe(true);
    expect(isWildcard(undefined)).toBe(true);
    expect(isWildcard("")).toBe(true);
    expect(isWildcard("   ")).toBe(true);
    expect(isWildcard("*")).toBe(true);
    expect(isWildcard("Foo")).toBe(false);
  });

  test("decodePayload round-trips encodePayload", () => {
    const decoded = decodePayload("WalletOpened,WalletClosed|amount,wallet_id");
    expect(decoded.wildcard).toBe(false);
    expect([...decoded.types].sort()).toEqual(["WalletClosed", "WalletOpened"]);
    expect([...decoded.tagKeys].sort()).toEqual(["amount", "wallet_id"]);
  });

  test("shouldWake: wildcard always wakes", () => {
    expect(shouldWake({ wildcard: true, types: new Set<string>(), tagKeys: new Set<string>() }, {})).toBe(true);
  });

  test("shouldWake: disjoint event types does not wake", () => {
    const batch = { wildcard: false, types: new Set(["A"]), tagKeys: new Set<string>() };
    expect(shouldWake(batch, { eventTypes: new Set(["B"]) })).toBe(false);
    expect(shouldWake(batch, { eventTypes: new Set(["A", "B"]) })).toBe(true);
  });

  test("shouldWake: requiredTagKeys must all be present", () => {
    const batch = { wildcard: false, types: new Set(["A"]), tagKeys: new Set(["k1"]) };
    expect(shouldWake(batch, { requiredTagKeys: new Set(["k1", "k2"]) })).toBe(false);
    expect(shouldWake(batch, { requiredTagKeys: new Set(["k1"]) })).toBe(true);
  });

  test("shouldWake: anyOfTagKeys needs at least one match", () => {
    const batch = { wildcard: false, types: new Set(["A"]), tagKeys: new Set(["k1"]) };
    expect(shouldWake(batch, { anyOfTagKeys: new Set(["k9", "k1"]) })).toBe(true);
    expect(shouldWake(batch, { anyOfTagKeys: new Set(["k9"]) })).toBe(false);
  });

  test("shouldWake: tag checks skipped when batch carries no tag keys", () => {
    const batch = { wildcard: false, types: new Set(["A"]), tagKeys: new Set<string>() };
    expect(shouldWake(batch, { requiredTagKeys: new Set(["k1"]) })).toBe(true);
  });
});
