import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { VIEWS_LOCK_KEY } from "../packages/views/src/ViewsModule.ts";
import { AUTOMATIONS_LOCK_KEY } from "../packages/automations/src/AutomationsModule.ts";
import { OUTBOX_LOCK_KEY } from "../packages/outbox/src/OutboxModule.ts";
import { DEADLINES_LOCK_KEY } from "../packages/deadlines/src/DeadlinesModule.ts";

describe("module lock keys", () => {
  // A rolling deploy runs old and new versions side by side: they must take the same lock, or both would lead. These are the values the event store
  // defined before the keys moved to their modules (2026-11-23).
  test("keep the values they had", () => {
    expect({ views: VIEWS_LOCK_KEY, automations: AUTOMATIONS_LOCK_KEY, outbox: OUTBOX_LOCK_KEY, deadlines: DEADLINES_LOCK_KEY }).toEqual({
      views: 4856221667890123457n,
      automations: 4856221667890123458n,
      outbox: 4856221667890123456n,
      deadlines: 4856221667890123459n
    });
  });

  // Open/closed: a new kind of module brings its own key, without a change to the event store, which holds only the mechanism.
  test("the event store defines none", () => {
    const dir = path.resolve(import.meta.dir, "../packages/eventstore/src");
    const defining = readdirSync(dir, { recursive: true })
      .map(String)
      .filter((f) => f.endsWith(".ts"))
      .filter((f) => /\b[A-Z]+_LOCK_KEY\s*=/u.test(readFileSync(path.join(dir, f), "utf8")));
    expect(defining).toEqual([]);
  });
});
