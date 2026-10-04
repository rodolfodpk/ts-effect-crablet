import { describe, expect, it } from "bun:test";
import { Effect, Queue, Scope } from "effect";
import { makeViewProgressHub, type ListenSource, type ViewProgressHubService } from "../src/ViewProgressHub.ts";

const sqlError = (message: string) => ({ _tag: "SqlError", message }) as never;
const ping = (id: string, position: number) => JSON.stringify({ id, transactionId: String(position), position: String(position) });

// A notification source the test controls: each `listen` makes a fresh queue (the "connection"), which the test can push into or fail.
const fakeSource = () => {
  const state = { connects: 0, failNextConnects: 0, current: null as Queue.Queue<{ readonly payload: string }, never> | null };
  const source: ListenSource = Effect.gen(function* () {
    if (state.failNextConnects > 0) {
      state.failNextConnects--;
      return yield* Effect.fail(sqlError("connection refused"));
    }
    state.connects++;
    const queue = yield* Queue.unbounded<{ readonly payload: string }, never>();
    state.current = queue;
    yield* Effect.addFinalizer(() => Queue.shutdown(queue));
    return queue as never;
  });
  return {
    state,
    source,
    push: (payload: string) => Queue.offerUnsafe(state.current!, { payload }),
    drop: () => Effect.runPromise(Queue.fail(state.current as unknown as Queue.Queue<{ readonly payload: string }, unknown>, sqlError("connection lost")))
  };
};

const retry = { retryBase: "5 millis", retryMax: "20 millis" } as const;

// Runs `body` with a hub over `source`, inside a scope that closes (and stops the hub) afterwards.
const withHub = async <A>(source: ListenSource, body: (hub: ViewProgressHubService) => Effect.Effect<A, unknown, Scope.Scope>): Promise<A> =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const hub = yield* makeViewProgressHub({ source, ...retry });
        return yield* body(hub);
      })
    ) as Effect.Effect<A>
  );

const until = async (check: () => boolean | Promise<boolean>, ms = 2000) => {
  const start = Date.now();
  while (!(await check())) {
    if (Date.now() - start > ms) throw new Error("condition not reached in time");
    await new Promise((r) => setTimeout(r, 5));
  }
};

describe("ViewProgressHub: delivery", () => {
  it("gives a subscriber the pings of the views it asked for, and none of the others", async () => {
    const fake = fakeSource();
    await withHub(fake.source, (hub) =>
      Effect.gen(function* () {
        const sub = yield* hub.subscribe(new Set(["balance"]));
        yield* Effect.promise(() => until(() => fake.state.connects === 1));
        yield* sub.next; // the first connect is announced as a resync
        fake.push(ping("summary", 1));
        fake.push(ping("balance", 2));
        const batch = yield* sub.next;
        expect(batch.pings).toEqual([{ id: "balance", transactionId: "2", position: "2" }]);
        expect(batch.resync).toBe(false);
      })
    );
  });

  it("a subscriber that names no views gets every view", async () => {
    const fake = fakeSource();
    await withHub(fake.source, (hub) =>
      Effect.gen(function* () {
        const sub = yield* hub.subscribe(null);
        yield* Effect.promise(() => until(() => fake.state.connects === 1));
        yield* sub.next;
        fake.push(ping("a", 1));
        fake.push(ping("b", 2));
        yield* Effect.sleep("30 millis");
        const batch = yield* sub.next;
        expect(batch.pings.map((p) => p.id).sort()).toEqual(["a", "b"]);
      })
    );
  });

  it("coalesces a burst for one view into the latest ping, and keeps another view's ping", async () => {
    const fake = fakeSource();
    await withHub(fake.source, (hub) =>
      Effect.gen(function* () {
        const sub = yield* hub.subscribe(null);
        yield* Effect.promise(() => until(() => fake.state.connects === 1));
        yield* sub.next;
        for (let n = 1; n <= 500; n++) fake.push(ping("busy", n));
        fake.push(ping("quiet", 1000));
        for (let n = 501; n <= 1000; n++) fake.push(ping("busy", n));
        yield* Effect.sleep("50 millis");
        const batch = yield* sub.next;
        expect(batch.pings).toHaveLength(2);
        expect(batch.pings.find((p) => p.id === "busy")!.position).toBe("1000");
        expect(batch.pings.find((p) => p.id === "quiet")!.position).toBe("1000");
      })
    );
  });

  it("`next` waits until there is something to report", async () => {
    const fake = fakeSource();
    await withHub(fake.source, (hub) =>
      Effect.gen(function* () {
        const sub = yield* hub.subscribe(new Set(["a"]));
        yield* Effect.promise(() => until(() => fake.state.connects === 1));
        yield* sub.next;
        const quiet = yield* Effect.exit(Effect.timeout(sub.next, "60 millis"));
        expect(quiet._tag).toBe("Failure"); // nothing arrived: it did not return an empty batch
        fake.push(ping("other", 1)); // a view it did not ask for does not wake it either
        const stillQuiet = yield* Effect.exit(Effect.timeout(sub.next, "60 millis"));
        expect(stillQuiet._tag).toBe("Failure");
      })
    );
  });

  it("drops a payload it cannot decode and keeps going", async () => {
    const fake = fakeSource();
    await withHub(fake.source, (hub) =>
      Effect.gen(function* () {
        const sub = yield* hub.subscribe(null);
        yield* Effect.promise(() => until(() => fake.state.connects === 1));
        yield* sub.next;
        fake.push("this is not json");
        fake.push(JSON.stringify({ id: 7 }));
        fake.push(ping("ok", 3));
        yield* Effect.sleep("30 millis");
        expect((yield* sub.next).pings).toEqual([{ id: "ok", transactionId: "3", position: "3" }]);
      })
    );
  });
});

describe("ViewProgressHub: connection", () => {
  it("is not connected until LISTEN is confirmed, then is; the first connect tells a subscriber to re-read", async () => {
    const fake = fakeSource();
    await withHub(fake.source, (hub) =>
      Effect.gen(function* () {
        const sub = yield* hub.subscribe(new Set(["a"]));
        yield* Effect.promise(() => until(() => fake.state.connects === 1));
        const first = yield* sub.next;
        expect(first).toEqual({ pings: [], resync: true });
        expect(yield* hub.connected).toBe(true);
      })
    );
  });

  it("reconnects after the connection is lost, tells every subscriber to re-read, and pings flow again", async () => {
    const fake = fakeSource();
    await withHub(fake.source, (hub) =>
      Effect.gen(function* () {
        const a = yield* hub.subscribe(new Set(["a"]));
        const b = yield* hub.subscribe(null);
        yield* Effect.promise(() => until(() => fake.state.connects === 1));
        yield* a.next;
        yield* b.next;

        yield* Effect.promise(() => fake.drop());
        yield* Effect.promise(() => until(() => fake.state.connects === 2));
        expect((yield* a.next).resync).toBe(true);
        expect((yield* b.next).resync).toBe(true);
        expect(yield* hub.connected).toBe(true);

        fake.push(ping("a", 9));
        expect((yield* a.next).pings).toEqual([{ id: "a", transactionId: "9", position: "9" }]);
      })
    );
  });

  it("is disconnected while it retries, and keeps retrying with backoff until LISTEN works", async () => {
    const fake = fakeSource();
    fake.state.failNextConnects = 3;
    await withHub(fake.source, (hub) =>
      Effect.gen(function* () {
        const sub = yield* hub.subscribe(null);
        expect(yield* hub.connected).toBe(false);
        yield* Effect.promise(() => until(() => fake.state.connects === 1));
        expect((yield* sub.next).resync).toBe(true);
        expect(fake.state.failNextConnects).toBe(0);
        expect(yield* hub.connected).toBe(true);
      })
    );
  });

  it("a connection lost twice in a row is reconnected twice", async () => {
    const fake = fakeSource();
    await withHub(fake.source, (hub) =>
      Effect.gen(function* () {
        const sub = yield* hub.subscribe(null);
        yield* Effect.promise(() => until(() => fake.state.connects === 1));
        yield* sub.next;
        for (const expected of [2, 3]) {
          yield* Effect.promise(() => fake.drop());
          yield* Effect.promise(() => until(() => fake.state.connects === expected));
          expect((yield* sub.next).resync).toBe(true);
        }
      })
    );
  });
});

describe("ViewProgressHub: subscriptions", () => {
  it("a subscription ends with its scope and stops accumulating pings", async () => {
    const fake = fakeSource();
    await withHub(fake.source, (hub) =>
      Effect.gen(function* () {
        yield* Effect.promise(() => until(() => fake.state.connects === 1));
        expect(yield* hub.subscriberCount).toBe(0);
        const inner = yield* Scope.make();
        yield* Scope.provide(hub.subscribe(null), inner);
        expect(yield* hub.subscriberCount).toBe(1);
        yield* Scope.close(inner, { _tag: "Success", value: undefined } as never);
        expect(yield* hub.subscriberCount).toBe(0);
        fake.push(ping("a", 1)); // delivered to nobody: nothing to leak
        yield* Effect.sleep("20 millis");
        expect(yield* hub.subscriberCount).toBe(0);
      })
    );
  });

  it("many subscribers share the one connection", async () => {
    const fake = fakeSource();
    await withHub(fake.source, (hub) =>
      Effect.gen(function* () {
        yield* Effect.promise(() => until(() => fake.state.connects === 1));
        // subscribers that join a connected hub get no resync of their own (they read the state themselves, after subscribing)
        const subs = [];
        for (let n = 0; n < 300; n++) subs.push(yield* hub.subscribe(new Set([`view-${n % 3}`])));
        fake.push(ping("view-1", 5));
        yield* Effect.sleep("30 millis");
        let woken = 0;
        for (const s of subs) {
          const r = yield* Effect.exit(Effect.timeout(s.next, "5 millis"));
          if (r._tag === "Success") woken++;
        }
        expect(woken).toBe(100); // the 100 subscribers of view-1, and nobody else
        expect(fake.state.connects).toBe(1);
      })
    );
  });
});
