import { describe, expect, test } from "bun:test";
import { Effect, Ref } from "effect";
import { holdSession, holdSessionOnce, SessionClients, sessionPoolWarning } from "../src/SessionClients.ts";

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

// The framework counts what starts (`holdSession`): each module 2 (its leader lock and its LISTEN; 1 with wake-ups off), the views' progress hub 1.
describe("holdSession", () => {
  const sessionWith = (maxConnections: number | undefined) =>
    Effect.gen(function* () {
      return { sql: null as never, pg: null as never, maxConnections, held: yield* Ref.make(0), warned: yield* Ref.make(false) };
    });
  const start = (session: SessionClients, ...holds: ReadonlyArray<number>) =>
    Effect.runPromise(Effect.provideService(Effect.forEach(holds, (n, i) => holdSession(`part ${i}`, n), { discard: true }), SessionClients, session));

  test("adds up what the process keeps: three modules and the hub are 7, as measured", async () => {
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
    const once = await Effect.runPromise(holdSessionOnce("a module", 2));
    await Effect.runPromise(Effect.provideService(Effect.all([once, once, once], { discard: true }), SessionClients, session));
    expect(await Effect.runPromise(Ref.get(session.held))).toBe(2);
  });

  test("without session clients there is nothing to count", async () => {
    await Effect.runPromise(holdSession("anything", 99));
  });
});
