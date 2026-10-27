// Runs under Bun, no database: the leader's heartbeat against a stand-in connection that answers exactly what Postgres would.
// The case that matters: a session that ANSWERS queries but no longer holds the advisory lock (a pooled connection that came back on a new session). A heartbeat of
// `SELECT 1` would call that session healthy; the leader must ask Postgres whether THIS session holds the lock (pg_locks), and give up when it does not.
import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import type { SqlClient } from "effect/sql";
import type { Connection } from "effect/sql/SqlConnection";
import { ConnectionError, SqlError } from "effect/sql/SqlError";
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

describe("leader: when the session fails", () => {
  // A stand-in like `sharing`, that can also make chosen statements fail or never answer, and checks that each statement passes exactly the
  // parameters its placeholders ask for, as Postgres does.
  const scripted = () => {
    const held = new Set<string>();
    // Keys another process holds: the attempt at them is refused.
    const elsewhere = new Set<string>();
    const queries: Array<string> = [];
    const mismatches: Array<string> = [];
    const faults: Array<{ match: string; kind: "fail" | "hang"; times: number }> = [];
    let reserved = 0;
    let returned = 0;
    let interrupted = 0;
    const lost = () => new SqlError({ reason: new ConnectionError({ cause: new Error("boom"), message: "connection lost" }) });
    const connection = {
      execute: (query: string, params: ReadonlyArray<string>) =>
        Effect.suspend(() => {
          const placeholders = new Set(query.match(/\$\d+/g) ?? []).size;
          if (params.length !== placeholders) mismatches.push(`${placeholders} placeholders, ${params.length} parameters: ${query}`);
          queries.push(query);
          const fault = faults.find((f) => query.includes(f.match) && f.times > 0);
          if (fault !== undefined) {
            fault.times--;
            if (fault.kind === "fail") return Effect.fail(lost());
            return Effect.never.pipe(Effect.onInterrupt(() => Effect.sync(() => void interrupted++)));
          }
          if (query.includes("pg_try_advisory_lock")) {
            if (elsewhere.has(params[0]!)) return Effect.succeed([{ acquired: false }]);
            held.add(params[0]!);
            return Effect.succeed([{ acquired: true }]);
          }
          if (query.includes("pg_advisory_unlock")) { held.delete(params[0]!); return Effect.succeed([{}]); }
          if (query.includes("pg_locks")) return Effect.succeed([...held].map((key) => ({ key })));
          return Effect.succeed([{}]);
        })
    } as unknown as Connection;
    const sql = {
      reserve: Effect.acquireRelease(Effect.sync(() => { reserved++; return connection; }), () => Effect.sync(() => { returned++; }))
    } as unknown as SqlClient.SqlClient;
    return {
      sql,
      held,
      elsewhere,
      queries,
      mismatches,
      counts: () => ({ reserved, returned }),
      interrupted: () => interrupted,
      fault: (match: string, kind: "fail" | "hang", times = 1) => void faults.push({ match, kind, times })
    };
  };
  const quick = { heartbeat: "1 hour", verifyTimeout: "40 millis", failuresBeforeLost: 1, serverIdleTimeout: "off" } as const;
  const lead = (sql: SqlClient.SqlClient, key: bigint, options: Parameters<typeof tryAcquireGlobalLeader>[2] = quick) => Effect.runPromise(tryAcquireGlobalLeader(sql, key, options));
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  test("the heartbeat alone finds a lost lock: the leader is lost and its connection goes back, with no verify called; a lost leader's verify asks nothing", async () => {
    const s = scripted();
    const leader = (await lead(s.sql, 1n, fast))!;
    s.held.clear(); // the session no longer holds the lock
    await sleep(100);
    expect(leader.isLeader()).toBe(false);
    expect(s.counts()).toEqual({ reserved: 1, returned: 1 });
    const asked = s.queries.length;
    expect(await Effect.runPromise(leader.verify)).toBe(false);
    expect(s.queries.length).toBe(asked);
    // The module leads again at once, on a new session.
    const again = (await lead(s.sql, 1n, fast))!;
    expect(again.isLeader()).toBe(true);
    expect(s.counts().reserved).toBe(2);
    await Effect.runPromise(again.release());
    expect(s.mismatches).toEqual([]);
  });

  test("one heartbeat for the session, not one per leader", async () => {
    const s = scripted();
    const options = { heartbeat: "40 millis", verifyTimeout: "500 millis", failuresBeforeLost: 1 } as const;
    const a = (await lead(s.sql, 1n, options))!;
    const b = (await lead(s.sql, 2n, options))!;
    await sleep(100);
    expect(s.queries.filter((q) => q.includes("pg_locks")).length).toBeLessThanOrEqual(3); // two at 40 and 80 ms; two heartbeats would make four
    await Effect.runPromise(a.release());
    await Effect.runPromise(b.release());
  });

  test("a failed check is a failed check, not a crash: verify answers false and the leader stays until the threshold", async () => {
    const s = scripted();
    const leader = (await lead(s.sql, 1n, { ...quick, failuresBeforeLost: 2 }))!;
    s.fault("pg_locks", "fail");
    expect(await Effect.runPromise(leader.verify)).toBe(false);
    expect(leader.isLeader()).toBe(true);
    await Effect.runPromise(leader.release());
  });

  test("a check that does not answer counts as failed at verifyTimeout, and the statement is interrupted", async () => {
    const s = scripted();
    const leader = (await lead(s.sql, 1n))!;
    s.fault("pg_locks", "hang");
    expect(await Effect.runPromise(leader.verify)).toBe(false);
    expect(leader.isLeader()).toBe(false);
    await sleep(20);
    expect(s.interrupted()).toBe(1);
  });

  test("a failed attempt on a session of its own gives the connection back and fails; one refused gives it back too", async () => {
    const s = scripted();
    s.fault("pg_try_advisory_lock", "fail");
    await expect(lead(s.sql, 1n)).rejects.toThrow(/connection lost/);
    expect(s.counts()).toEqual({ reserved: 1, returned: 1 });
    s.elsewhere.add("2");
    expect(await lead(s.sql, 2n)).toBeNull();
    expect(s.counts()).toEqual({ reserved: 2, returned: 2 });
    const noRow = standIn(() => []); // no row: not acquired
    expect(await Effect.runPromise(tryAcquireGlobalLeader(noRow.sql, 1n, quick))).toBeNull();
  });

  test("a failed attempt on a shared session loses its leaders, and the attempt is made again at once on a new session", async () => {
    const s = scripted();
    const first = (await lead(s.sql, 1n))!;
    s.fault("pg_try_advisory_lock", "fail");
    const second = await lead(s.sql, 2n);
    expect(second?.isLeader()).toBe(true);
    expect(first.isLeader()).toBe(false);
    await sleep(20);
    expect(s.counts()).toEqual({ reserved: 2, returned: 1 });
    // The old session's release, which ran after the new session was taken, did not take it from the next leader.
    const third = (await lead(s.sql, 3n))!;
    expect(s.counts().reserved).toBe(2);
    await Effect.runPromise(third.release());
    await Effect.runPromise(second!.release());
    expect(s.mismatches).toEqual([]);
  });

  test("a refused attempt on a shared session keeps the session for the leader on it", async () => {
    const s = scripted();
    const first = (await lead(s.sql, 1n))!;
    s.elsewhere.add("2");
    expect(await lead(s.sql, 2n)).toBeNull();
    expect(first.isLeader()).toBe(true);
    expect(s.counts()).toEqual({ reserved: 1, returned: 0 });
    await Effect.runPromise(first.release());
  });

  test("a statement that does not answer abandons the session: its leaders are lost, nothing is unlocked on it, and it goes back once the statement is interrupted", async () => {
    const s = scripted();
    const first = (await lead(s.sql, 1n))!;
    s.fault("pg_try_advisory_lock", "hang");
    await expect(lead(s.sql, 2n)).rejects.toThrow(/did not answer the attempt for the lock 2 within 40 ms/);
    expect(first.isLeader()).toBe(false);
    await sleep(20);
    expect(s.interrupted()).toBe(1);
    expect(s.counts()).toEqual({ reserved: 1, returned: 1 });
    expect(s.queries.some((q) => q.includes("pg_advisory_unlock"))).toBe(false);
    // The next attempts share a new session; the late close of the abandoned one does not take it from them.
    const third = (await lead(s.sql, 3n))!;
    const fourth = (await lead(s.sql, 4n))!;
    expect(s.counts()).toEqual({ reserved: 2, returned: 1 });
    await Effect.runPromise(third.release());
    await Effect.runPromise(fourth.release());
  });

  test("a lease that cannot be set gives the lock and the connection back, and the attempt fails", async () => {
    const s = scripted();
    s.fault("SET idle_session_timeout", "fail");
    await expect(lead(s.sql, 1n, { ...quick, serverIdleTimeout: "2 hours" })).rejects.toThrow(/connection lost/);
    expect(s.queries.at(-1)).toBe("SELECT pg_advisory_unlock($1)");
    expect(s.held.size).toBe(0);
    expect(s.counts()).toEqual({ reserved: 1, returned: 1 });
    expect(s.mismatches).toEqual([]);
  });

  test("the last release gives the connection back: the next attempt reserves a new one", async () => {
    const s = scripted();
    await Effect.runPromise((await lead(s.sql, 1n, { ...quick, serverIdleTimeout: "2 hours" }))!.release());
    await Effect.runPromise((await lead(s.sql, 1n, { ...quick, serverIdleTimeout: "2 hours" }))!.release());
    expect(s.counts()).toEqual({ reserved: 2, returned: 2 });
    expect(s.mismatches).toEqual([]);
  });

  test("a pool that gives no connection fails the attempt: with its own error, or saying so at reserveTimeout", async () => {
    const failing = { reserve: Effect.fail(new SqlError({ reason: new ConnectionError({ cause: new Error("x"), message: "pool closed" }) })) } as unknown as SqlClient.SqlClient;
    await expect(lead(failing, 1n)).rejects.toThrow(/pool closed/);
    const busy = { reserve: Effect.never } as unknown as SqlClient.SqlClient;
    await expect(lead(busy, 1n, { ...quick, reserveTimeout: "30 millis" })).rejects.toThrow(/no connection from the pool in 30 ms for the leader lock 1/);
  });

  test("with no options it leads, with the defaults", async () => {
    const s = scripted();
    const leader = (await Effect.runPromise(tryAcquireGlobalLeader(s.sql, 1n)))!;
    expect(leader.isLeader()).toBe(true);
    expect(s.queries[1]).toBe("SET idle_session_timeout = '15000ms'");
    await Effect.runPromise(leader.release());
  });
});
