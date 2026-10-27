import { describe, expect, test } from "bun:test";
import { Effect, Logger, Ref } from "effect";
import { SqlClient } from "effect/sql";
import { PgClient } from "@effect/sql-pg";
import { holdSession, holdSessionOnce, SessionClients, sessionPg, sessionPoolWarning, sessionSql } from "../src/SessionClients.ts";

// What a process keeps in its session pool for good: one connection per module that leads (a reserved one), one per LISTEN (the modules' wake-ups, and the views' progress hub
// where the api runs). The framework counts it as those start (see holdSession below).
describe("sessionPoolWarning", () => {
  test("a pool at least as big as what the process holds says nothing", () => {
    expect(sessionPoolWarning(7, 7)).toBeNull();
    expect(sessionPoolWarning(10, 7)).toBeNull();
    expect(sessionPoolWarning(2, 2)).toBeNull();
    expect(sessionPoolWarning(1, 1)).toBeNull();
  });

  test("a smaller pool names both numbers and what happens", () => {
    const warning = sessionPoolWarning(5, 7)!;
    expect(warning).toContain("5");
    expect(warning).toContain("7");
    expect(warning).toMatch(/wait/);
  });

  test("with no pool size given there is nothing to compare, so it says nothing", () => {
    expect(sessionPoolWarning(1, undefined)).toBeNull();
    expect(sessionPoolWarning(undefined, 7)).toBeNull();
  });
});

// The framework counts what starts (`holdSession`): the process's lock session once (ADR-0046). The LISTENs are not in the pool: they share a
// connection of their own (`sharedListen`).
describe("holdSession", () => {
  const sessionWith = (maxConnections: number | undefined) =>
    Effect.gen(function* () {
      return { sql: null as never, pg: null as never, maxConnections, held: yield* Ref.make(0), warned: yield* Ref.make(false), lockSessionCounted: yield* Ref.make(false) };
    });
  const start = (session: SessionClients, ...holds: ReadonlyArray<number>) =>
    Effect.runPromise(Effect.provideService(Effect.forEach(holds, (n, i) => holdSession(`part ${i}`, n), { discard: true }), SessionClients, session));

  test("adds up what the process keeps", async () => {
    const session = await Effect.runPromise(sessionWith(10));
    await start(session, 2, 2, 2, 1);
    expect(await Effect.runPromise(Ref.get(session.held))).toBe(7);
    expect(await Effect.runPromise(Ref.get(session.warned))).toBe(false);
  });

  test("warns once when the total passes the pool, not on every start after", async () => {
    const session = await Effect.runPromise(sessionWith(5));
    await start(session, 2, 2);
    expect(await Effect.runPromise(Ref.get(session.warned))).toBe(false);
    await start(session, 2, 1);
    expect(await Effect.runPromise(Ref.get(session.held))).toBe(7);
    expect(await Effect.runPromise(Ref.get(session.warned))).toBe(true);
  });

  test("a module counts once, however many times it tries for its lock", async () => {
    const session = await Effect.runPromise(sessionWith(10));
    const once = await Effect.runPromise(holdSessionOnce("a module"));
    await Effect.runPromise(Effect.provideService(Effect.all([once, once, once], { discard: true }), SessionClients, session));
    expect(await Effect.runPromise(Ref.get(session.held))).toBe(1); // the process's lock session
  });

  test("the lock session counts once for the process, however many modules lead (ADR-0046): four modules keep 1", async () => {
    const session = await Effect.runPromise(sessionWith(10));
    const modules = await Effect.runPromise(Effect.all([holdSessionOnce("views"), holdSessionOnce("automations"), holdSessionOnce("outbox"), holdSessionOnce("deadlines")]));
    await Effect.runPromise(Effect.provideService(Effect.all(modules, { discard: true }), SessionClients, session));
    expect(await Effect.runPromise(Ref.get(session.held))).toBe(1);
  });

  test("without session clients there is nothing to count", async () => {
    await Effect.runPromise(holdSession("anything", 99));
    await Effect.runPromise(Effect.flatten(holdSessionOnce("a module")));
  });

  test("the warning is logged once, naming what started last", async () => {
    const lines: Array<string> = [];
    const capture = Logger.layer([Logger.make((o) => void lines.push(String(o.message)))], { mergeWithExisting: false });
    const session = await Effect.runPromise(sessionWith(1));
    await Effect.runPromise(Effect.provide(Effect.provideService(Effect.all([holdSession("views", 1), holdSession("outbox", 1), holdSession("api", 1)], { discard: true }), SessionClients, session), capture));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("maxConnections is 1, but this process keeps 2 of them for good");
    expect(lines[0]).toContain("(last to start: outbox)");
  });
});

describe("the clients a leader and a LISTEN use", () => {
  test("the session clients when there are some, the application's otherwise", async () => {
    const app = { name: "app" } as never;
    const sessionSqlClient = { name: "session sql" } as never;
    const sessionPgClient = { name: "session pg" } as never;
    const session = { sql: sessionSqlClient, pg: sessionPgClient } as unknown as SessionClients;
    const both = <A>(effect: Effect.Effect<A, never, never>) => Effect.runPromise(effect);
    expect(await both(Effect.provideService(sessionSql, SqlClient.SqlClient, app))).toBe(app);
    expect(await both(Effect.provideService(sessionPg, PgClient.PgClient, app))).toBe(app);
    expect(await both(Effect.provideService(Effect.provideService(sessionSql, SqlClient.SqlClient, app), SessionClients, session))).toBe(sessionSqlClient);
    expect(await both(Effect.provideService(Effect.provideService(sessionPg, PgClient.PgClient, app), SessionClients, session))).toBe(sessionPgClient);
  });
});
