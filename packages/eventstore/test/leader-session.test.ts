// Runs under Bun, no database: the leader's heartbeat against a stand-in connection that answers exactly what Postgres would.
// The case that matters: a session that ANSWERS queries but no longer holds the advisory lock (a pooled connection that came back on a new session). A heartbeat of
// `SELECT 1` would call that session healthy; the leader must ask Postgres whether THIS session holds the lock (pg_locks), and give up when it does not.
import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import type { SqlClient } from "effect/sql";
import type { Connection } from "effect/sql/SqlConnection";
import { afterCheck, afterRelease, leading, lossDetectionBound, serverIdleTimeoutOf, tryAcquireGlobalLeader } from "../src/Leader.ts";
import { Duration } from "effect";

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

// The heartbeat's query lists the keys this session holds.
const holdsLock = (query: string) => (query.includes("pg_try_advisory_lock") ? [{ acquired: true }] : query.includes("pg_locks") ? [{ key: "42" }] : [{}]);
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
    const { sql } = standIn((q) => (q.includes("pg_try_advisory_lock") ? [{ acquired: true }] : q.includes("pg_locks") ? (healthy ? [{ key: "42" }] : []) : [{}]));
    const leader = (await Effect.runPromise(tryAcquireGlobalLeader(sql, 42n, { heartbeat: "1 hour", verifyTimeout: "500 millis", failuresBeforeLost: 2, serverIdleTimeout: "off" })))!;
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

describe("leader: the lease is the session (ADR-0045)", () => {
  test("taking the lock asks for a primary first, and the heartbeat's check requires one", async () => {
    const { sql, queries } = standIn(holdsLock);
    const leader = (await Effect.runPromise(tryAcquireGlobalLeader(sql, 42n, fast)))!;
    await Effect.runPromise(leader.verify);
    expect(queries[0]).toMatch(/CASE WHEN pg_is_in_recovery\(\) THEN false ELSE pg_try_advisory_lock/);
    expect(queries.find((q) => q.includes("pg_locks"))).toMatch(/NOT pg_is_in_recovery\(\)/);
    await Effect.runPromise(leader.release());
  });

  test("the lock session sets idle_session_timeout once it holds the lock, and resets it when it gives the lock back", async () => {
    const { sql, queries } = standIn(holdsLock);
    const leader = (await Effect.runPromise(tryAcquireGlobalLeader(sql, 42n, fast)))!;
    expect(queries[1]).toBe("SET idle_session_timeout = '15000ms'");
    await Effect.runPromise(leader.release());
    const unlock = queries.findIndex((q) => q.includes("pg_advisory_unlock"));
    expect(queries[unlock + 1]).toBe("RESET idle_session_timeout");
  });

  test("an attempt that does not get the lock sets nothing; \"off\" sets nothing either", async () => {
    const refused = standIn(() => [{ acquired: false }]);
    await Effect.runPromise(tryAcquireGlobalLeader(refused.sql, 42n, fast));
    expect(refused.queries.some((q) => q.includes("idle_session_timeout"))).toBe(false);
    const off = standIn(holdsLock);
    const leader = (await Effect.runPromise(tryAcquireGlobalLeader(off.sql, 42n, { ...fast, serverIdleTimeout: "off" })))!;
    await Effect.runPromise(leader.release());
    expect(off.queries.some((q) => q.includes("idle_session_timeout"))).toBe(false);
  });

  test("the timeout must be longer than the leader's own loss detection: a shorter one is refused, naming both", async () => {
    expect(Duration.toMillis(lossDetectionBound({}))).toBe(6_000); // 2 x (1 s + 2 s)
    expect(Duration.toMillis(serverIdleTimeoutOf({})!)).toBe(15_000);
    expect(() => serverIdleTimeoutOf({ serverIdleTimeout: "6 seconds" })).toThrow(/6000 ms.*6000 ms/);
    expect(() => serverIdleTimeoutOf({ heartbeat: "5 seconds", verifyTimeout: "5 seconds" })).toThrow(/must be longer/);
    expect(serverIdleTimeoutOf({ heartbeat: "1 hour", serverIdleTimeout: "off" })).toBeNull();
    const { sql } = standIn(holdsLock);
    await expect(Effect.runPromise(tryAcquireGlobalLeader(sql, 42n, { heartbeat: "1 hour" }))).rejects.toThrow(/serverIdleTimeout/);
  });
});

describe("leader: one lock session per process (ADR-0046)", () => {
  // A stand-in that counts the connections reserved and returned, and answers the heartbeat with the keys the session took and still holds.
  const sharing = () => {
    const held = new Set<string>();
    const queries: Array<string> = [];
    let reserved = 0;
    let returned = 0;
    const connection = {
      execute: (query: string, params: ReadonlyArray<string>) =>
        Effect.sync(() => {
          queries.push(query);
          if (query.includes("pg_try_advisory_lock")) { held.add(params[0]!); return [{ acquired: true }]; }
          if (query.includes("pg_advisory_unlock")) { held.delete(params[0]!); return [{}]; }
          if (query.includes("pg_locks")) return [...held].map((key) => ({ key }));
          return [{}];
        })
    } as unknown as Connection;
    const sql = {
      reserve: Effect.acquireRelease(Effect.sync(() => { reserved++; return connection; }), () => Effect.sync(() => { returned++; }))
    } as unknown as SqlClient.SqlClient;
    return { sql, queries, counts: () => ({ reserved, returned }) };
  };

  test("two modules' leaders share one connection and one heartbeat; the connection goes back with the last lock", async () => {
    const { sql, queries, counts } = sharing();
    const views = (await Effect.runPromise(tryAcquireGlobalLeader(sql, 1n, fast)))!;
    const outbox = (await Effect.runPromise(tryAcquireGlobalLeader(sql, 2n, fast)))!;
    expect(counts()).toEqual({ reserved: 1, returned: 0 });
    expect(queries.filter((q) => q.includes("idle_session_timeout") && q.startsWith("SET"))).toHaveLength(1); // the lease, once
    await new Promise((r) => setTimeout(r, 60));
    expect(views.isLeader() && outbox.isLeader()).toBe(true);
    await Effect.runPromise(views.release());
    expect(counts().returned).toBe(0); // the outbox still leads on it
    expect(outbox.isLeader()).toBe(true);
    expect(await Effect.runPromise(outbox.verify)).toBe(true);
    await Effect.runPromise(outbox.release());
    expect(counts()).toEqual({ reserved: 1, returned: 1 });
    expect(queries.filter((q) => q === "RESET idle_session_timeout")).toHaveLength(1);
  });

  test("a key the session already holds is refused: locks are re-entrant, and one module must not lead twice", async () => {
    const { sql } = sharing();
    const first = (await Effect.runPromise(tryAcquireGlobalLeader(sql, 7n, fast)))!;
    expect(await Effect.runPromise(tryAcquireGlobalLeader(sql, 7n, fast))).toBeNull();
    await Effect.runPromise(first.release());
    const again = await Effect.runPromise(tryAcquireGlobalLeader(sql, 7n, fast));
    expect(again).not.toBeNull();
    await Effect.runPromise(again!.release());
  });

  test("leaders with different options do not share: each gets a session of its own", async () => {
    const { sql, counts } = sharing();
    const a = (await Effect.runPromise(tryAcquireGlobalLeader(sql, 1n, fast)))!;
    const b = (await Effect.runPromise(tryAcquireGlobalLeader(sql, 2n, { ...fast, serverIdleTimeout: "off" })))!;
    expect(counts().reserved).toBe(2);
    await Effect.runPromise(a.release());
    await Effect.runPromise(b.release());
  });
});

describe("leader state: the pure transitions", () => {
  test("a good check keeps leading and clears the count of failures", () => {
    expect(afterCheck(leading, true, 2)).toEqual(leading);
    expect(afterCheck({ status: "leading", failures: 1 }, true, 2)).toEqual(leading);
  });

  test("failures in a row make the leader lost, exactly at the threshold", () => {
    const one = afterCheck(leading, false, 3);
    expect(one).toEqual({ status: "leading", failures: 1 });
    const two = afterCheck(one, false, 3);
    expect(two).toEqual({ status: "leading", failures: 2 });
    expect(afterCheck(two, false, 3).status).toBe("lost");
    expect(afterCheck(leading, false, 1).status).toBe("lost");
  });

  test("a leader that is lost or closed does not come back to life, whatever the next check says", () => {
    const lost = afterCheck(leading, false, 1);
    expect(afterCheck(lost, true, 1)).toBe(lost);
    const closed = afterRelease(leading);
    expect(afterCheck(closed, true, 1)).toBe(closed);
    expect(afterCheck(closed, false, 1)).toBe(closed);
  });

  test("releasing closes it from any state, including a lost one (the lost leader is released next)", () => {
    expect(afterRelease(leading).status).toBe("closed");
    expect(afterRelease(afterCheck(leading, false, 1)).status).toBe("closed");
  });
});
