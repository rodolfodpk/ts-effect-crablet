import { describe, expect, test } from "bun:test";
import { Cause, Effect, Queue, Scope, Exit } from "effect";
import { SqlError } from "effect/sql/SqlError";
import { makeSharedListener, type Listener } from "../src/SharedListen.ts";

type Notification = { readonly payload: string };
const lost = () => new SqlError({ reason: { _tag: "ConnectionError", cause: new Error("connection terminated"), message: "terminated", operation: "listen" } as never });

// Fake connections: each `connect` opens the next one; a connection's listens fail once it is `kill`ed, and `closed` says whether its scope ended.
const fakeConnections = () => {
  const opened: Array<{ dead: boolean; closed: boolean; channels: Array<string>; queues: Array<Queue.Queue<Notification, SqlError>> }> = [];
  const connect: Effect.Effect<Listener, SqlError, Scope.Scope> = Effect.gen(function* () {
    const connection = { dead: false, closed: false, channels: [] as Array<string>, queues: [] as Array<Queue.Queue<Notification, SqlError>> };
    opened.push(connection);
    yield* Effect.addFinalizer(() => Effect.sync(() => void (connection.closed = true)));
    return {
      listen: (channel: string) =>
        Effect.gen(function* () {
          if (connection.dead) return yield* Effect.fail(lost());
          const queue = yield* Queue.unbounded<Notification, SqlError>();
          connection.channels.push(channel);
          connection.queues.push(queue);
          return queue;
        })
    };
  });
  // The connection is lost: its queues fail, as @effect/sql-pg fails them, and a listen on it fails.
  const kill = (i: number) =>
    Effect.gen(function* () {
      opened[i]!.dead = true;
      for (const queue of opened[i]!.queues) yield* Queue.fail(queue, lost());
    });
  return { opened, connect, kill };
};

describe("one LISTEN connection per process (sharedListen)", () => {
  test("listens on different channels share one connection, opened with the first and closed with the last", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const { opened, connect } = fakeConnections();
        const shared = makeSharedListener(connect);
        const a = yield* Scope.make();
        const b = yield* Scope.make();
        yield* Scope.provide(shared.listen("crablet_events"), a);
        yield* Scope.provide(shared.listen("crablet_events"), b);
        yield* Scope.provide(shared.listen("crablet_view_progress"), b);
        expect(opened.length).toBe(1);
        expect(opened[0]!.channels).toEqual(["crablet_events", "crablet_events", "crablet_view_progress"]);

        yield* Scope.close(a, Exit.void);
        expect(opened[0]!.closed).toBe(false); // b still listens
        yield* Scope.close(b, Exit.void);
        expect(opened[0]!.closed).toBe(true);

        const c = yield* Scope.make();
        yield* Scope.provide(shared.listen("crablet_events"), c);
        expect(opened.length).toBe(2); // a new one for the next listen
        yield* Scope.close(c, Exit.void);
      })
    );
  });

  test("a lost connection fails every queue on it; the first listen again replaces it, and the others listen on the new one", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const { opened, connect, kill } = fakeConnections();
        const shared = makeSharedListener(connect);
        const a = yield* Scope.make();
        const b = yield* Scope.make();
        const qa = yield* Scope.provide(shared.listen("crablet_events"), a);
        const qb = yield* Scope.provide(shared.listen("crablet_view_progress"), b);

        yield* kill(0);
        expect(Exit.isFailure(yield* Effect.exit(Queue.take(qa)))).toBe(true);
        expect(Exit.isFailure(yield* Effect.exit(Queue.take(qb)))).toBe(true);

        // Each stream reconnects in a scope of its own (wakeupStreamFrom); the old scopes end.
        yield* Scope.close(a, Exit.void);
        yield* Scope.close(b, Exit.void);
        const a2 = yield* Scope.make();
        const b2 = yield* Scope.make();
        yield* Scope.provide(shared.listen("crablet_events"), a2);
        yield* Scope.provide(shared.listen("crablet_view_progress"), b2);
        expect(opened.length).toBe(2);
        expect(opened[0]!.closed).toBe(true);
        expect(opened[1]!.channels).toEqual(["crablet_events", "crablet_view_progress"]);
        yield* Scope.close(a2, Exit.void);
        yield* Scope.close(b2, Exit.void);
        expect(opened[1]!.closed).toBe(true);
      })
    );
  });

  test("a stream that reconnects while another still holds the lost connection replaces it, and the other's next listen uses the new one", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const { opened, connect, kill } = fakeConnections();
        const shared = makeSharedListener(connect);
        const a = yield* Scope.make();
        const b = yield* Scope.make();
        yield* Scope.provide(shared.listen("crablet_events"), a);
        yield* Scope.provide(shared.listen("crablet_events"), b);
        yield* kill(0);

        // a reconnects first; b has not noticed yet, its old scope still open.
        yield* Scope.close(a, Exit.void);
        const a2 = yield* Scope.make();
        yield* Scope.provide(shared.listen("crablet_events"), a2);
        expect(opened.length).toBe(2);

        yield* Scope.close(b, Exit.void);
        const b2 = yield* Scope.make();
        yield* Scope.provide(shared.listen("crablet_events"), b2);
        expect(opened.length).toBe(2); // not a third
        yield* Scope.close(a2, Exit.void);
        yield* Scope.close(b2, Exit.void);
        expect(opened[1]!.closed).toBe(true);
      })
    );
  });

  test("a connection that cannot be opened fails the listen, and the next listen tries again", async () => {
    let attempts = 0;
    const shared = makeSharedListener(
      Effect.suspend(() => (++attempts === 1 ? Effect.fail(lost()) : Effect.succeed({ listen: () => Queue.unbounded<Notification, SqlError>() })))
    );
    await Effect.runPromise(
      Effect.gen(function* () {
        expect(Exit.isFailure(yield* Effect.exit(Effect.scoped(shared.listen("crablet_events"))))).toBe(true);
        expect(Exit.isSuccess(yield* Effect.exit(Effect.scoped(shared.listen("crablet_events"))))).toBe(true);
        expect(attempts).toBe(2);
      })
    );
  });

  test("a connection that opened part-way and then failed is closed, not left open", async () => {
    let closed = false;
    const shared = makeSharedListener(
      Effect.gen(function* () {
        yield* Effect.addFinalizer(() => Effect.sync(() => void (closed = true)));
        return yield* Effect.fail(lost());
      })
    );
    const exit = await Effect.runPromise(Effect.exit(Effect.scoped(shared.listen("crablet_events"))));
    expect(closed).toBe(true);
    // The listen fails with the connection's error, and nothing else: giving the listen back with no connection open is not a defect.
    expect(Exit.isFailure(exit) && exit.cause.reasons.every(Cause.isFailReason)).toBe(true);
  });
});
