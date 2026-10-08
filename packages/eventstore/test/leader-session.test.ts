// Runs under Bun, no database: the leader's heartbeat against a stand-in connection that answers exactly what Postgres would.
// The case that matters: a session that ANSWERS queries but no longer holds the advisory lock (a pooled connection that came back on a new session). A heartbeat of
// `SELECT 1` would call that session healthy; the leader must ask Postgres whether THIS session holds the lock (pg_locks), and give up when it does not.
import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import type { SqlClient } from "effect/sql";
import type { Connection } from "effect/sql/SqlConnection";
import { tryAcquireGlobalLeader } from "../src/Leader.ts";

const standIn = (answer: (query: string) => ReadonlyArray<unknown>) => {
  const queries: Array<string> = [];
  const connection = {
    execute: (query: string) => {
      queries.push(query);
      return Effect.sync(() => answer(query));
    }
  } as unknown as Connection;
  const sql = { reserve: Effect.acquireRelease(Effect.succeed(connection), () => Effect.void) } as unknown as SqlClient.SqlClient;
  return { sql, queries };
};

const holdsLock = (query: string) => (query.includes("pg_try_advisory_lock") ? [{ acquired: true }] : query.includes("pg_locks") ? [{ "?column?": 1 }] : [{}]);
const answersButHoldsNothing = (query: string) => (query.includes("pg_try_advisory_lock") ? [{ acquired: true }] : query.includes("pg_locks") ? [] : [{}]);
const fast = { heartbeat: "10 millis", verifyTimeout: "500 millis", failuresBeforeLost: 1 } as const;

describe("leader: does THIS session still hold the lock", () => {
  test("a session that holds the lock stays leader, and verify says so", async () => {
    const { sql } = standIn(holdsLock);
    const leader = (await Effect.runPromise(tryAcquireGlobalLeader(sql, 42n, fast)))!;
    expect(await Effect.runPromise(leader.verify)).toBe(true);
    await new Promise((r) => setTimeout(r, 60));
    expect(leader.isLeader()).toBe(true);
    await Effect.runPromise(leader.release());
  });

  test("a session that still answers queries but no longer holds the lock is NOT leader: the heartbeat asks pg_locks, not whether the connection is alive", async () => {
    const { sql, queries } = standIn(answersButHoldsNothing);
    const leader = (await Effect.runPromise(tryAcquireGlobalLeader(sql, 42n, fast)))!;
    expect(await Effect.runPromise(leader.verify)).toBe(false);
    expect(leader.isLeader()).toBe(false);
    expect(queries.some((q) => q.includes("pg_locks"))).toBe(true);
  });

  test("leadership is given up only after the configured number of failed checks in a row", async () => {
    let healthy = true;
    const { sql } = standIn((q) => (q.includes("pg_try_advisory_lock") ? [{ acquired: true }] : q.includes("pg_locks") ? (healthy ? [{ "?column?": 1 }] : []) : [{}]));
    const leader = (await Effect.runPromise(tryAcquireGlobalLeader(sql, 42n, { heartbeat: "1 hour", verifyTimeout: "500 millis", failuresBeforeLost: 2 })))!;
    healthy = false;
    expect(await Effect.runPromise(leader.verify)).toBe(false);
    expect(leader.isLeader()).toBe(true); // one failed check is not yet "lost"
    healthy = true;
    expect(await Effect.runPromise(leader.verify)).toBe(true); // and a good one resets the count
    healthy = false;
    expect(await Effect.runPromise(leader.verify)).toBe(false);
    expect(leader.isLeader()).toBe(true);
    expect(await Effect.runPromise(leader.verify)).toBe(false);
    expect(leader.isLeader()).toBe(false);
  });

  test("a lock someone else holds is not acquired: no handle", async () => {
    const { sql } = standIn(() => [{ acquired: false }]);
    expect(await Effect.runPromise(tryAcquireGlobalLeader(sql, 42n, fast))).toBeNull();
  });

  test("releasing unlocks and announces in one statement, once, and the handle stops leading", async () => {
    const { sql, queries } = standIn(holdsLock);
    const leader = (await Effect.runPromise(tryAcquireGlobalLeader(sql, 42n, fast)))!;
    await Effect.runPromise(leader.release());
    await Effect.runPromise(leader.release());
    expect(leader.isLeader()).toBe(false);
    expect(queries.filter((q) => q.includes("pg_advisory_unlock") && q.includes("pg_notify"))).toHaveLength(1);
  });
});
