import { describe, expect, test } from "bun:test";
import * as ProgressCursor from "@crablet/event-poller/ProgressCursor";
import { viewVerdict } from "../src/ViewVerdict.ts";

const at = (xid: string, position: bigint) => ProgressCursor.of(xid, position);
const write = at("100", 50n);

describe("viewVerdict: what a read does about one view, given where the view is", () => {
  test("a view at the write has caught up, whatever its status or whatever is pending", () => {
    for (const status of [null, "ACTIVE", "PAUSED", "FAILED"]) {
      for (const pending of [true, false]) expect(viewVerdict(write, at("100", 50n), status, pending)).toBe("caught_up");
    }
  });

  test("a view past the write has caught up, by position or by transaction id (the transaction id comes first)", () => {
    expect(viewVerdict(write, at("100", 51n), "ACTIVE", true)).toBe("caught_up");
    expect(viewVerdict(write, at("101", 1n), "ACTIVE", true)).toBe("caught_up");
  });

  test("a view with a higher position but an EARLIER transaction id has not caught up", () => {
    expect(viewVerdict(write, at("99", 9_999n), "ACTIVE", true)).toBe("wait");
  });

  test("behind the write with nothing of its own pending: caught up (the write is not an event the view handles), even if the view is FAILED", () => {
    for (const status of [null, "ACTIVE", "PAUSED", "FAILED"]) expect(viewVerdict(write, at("100", 10n), status, false)).toBe("caught_up");
  });

  test("behind the write with something pending: wait, unless the view is FAILED, which will not progress", () => {
    for (const status of [null, "ACTIVE", "PAUSED"]) expect(viewVerdict(write, at("100", 10n), status, true)).toBe("wait");
    expect(viewVerdict(write, at("100", 10n), "FAILED", true)).toBe("failed");
  });

  test("a view with no progress row yet is at the zero cursor with no status", () => {
    expect(viewVerdict(write, ProgressCursor.zero, null, true)).toBe("wait");
    expect(viewVerdict(write, ProgressCursor.zero, null, false)).toBe("caught_up");
    expect(viewVerdict(ProgressCursor.zero, ProgressCursor.zero, null, false)).toBe("caught_up");
  });
});
