import { describe, expect, test } from "bun:test";
import { Effect, Fiber, Queue, Ref, Scope, Stream } from "effect";
import { SqlError } from "effect/sql/SqlError";
import { wakeupStreamFrom, type WakeupBatch } from "../src/Listen.ts";
import { encodePayload } from "../src/NotifyPayload.ts";

type Source = Queue.Queue<{ readonly payload: string }, SqlError>;
const lost = () => new SqlError({ reason: { _tag: "ConnectionError", cause: new Error("connection terminated"), message: "terminated", operation: "listen" } as never });

// A fake LISTEN: each (re)connection hands out the next queue; a connection attempt may also fail.
const fakeListen = (steps: ReadonlyArray<Source | "fail">) =>
  Effect.gen(function* () {
    const n = yield* Ref.make(0);
    const listen: Effect.Effect<Queue.Dequeue<{ readonly payload: string }, SqlError>, SqlError, Scope.Scope> = Effect.gen(function* () {
      const i = yield* Ref.getAndUpdate(n, (x) => x + 1);
      const step = steps[Math.min(i, steps.length - 1)]!;
      if (step === "fail") return yield* Effect.fail(lost());
      return step;
    });
    return { listen, attempts: Ref.get(n) };
  });

const collect = (stream: Stream.Stream<WakeupBatch, SqlError>) =>
  Effect.gen(function* () {
    const out = yield* Queue.unbounded<WakeupBatch>();
    const fiber = yield* Stream.runForEach(stream, (b) => Queue.offer(out, b)).pipe(Effect.forkChild);
    return { out, fiber };
  });

const payload = (type: string) => ({ payload: encodePayload(new Set([type]), new Set()) });
const next = (q: Queue.Queue<WakeupBatch>) => Queue.take(q).pipe(Effect.timeout("3 seconds"));

describe("wakeupStream reconnects", () => {
  test("a lost connection does not end the stream: it reconnects, announces a wildcard, and delivers again", async () => {
    await Effect.runPromise(Effect.gen(function* () {
      const first = yield* Queue.unbounded<{ readonly payload: string }, SqlError>();
      const second = yield* Queue.unbounded<{ readonly payload: string }, SqlError>();
      const { listen, attempts } = yield* fakeListen([first, "fail", second]);
      const { out, fiber } = yield* collect(wakeupStreamFrom(listen, { retryBase: "10 millis", retryMax: "40 millis" }));

      yield* Queue.offer(first, payload("A"));
      expect([...(yield* next(out)).types]).toEqual(["A"]);

      yield* Queue.fail(first, lost()); // the connection drops
      const afterReconnect = yield* next(out);
      expect(afterReconnect.wildcard).toBe(true); // something may have been missed: poll
      expect(yield* attempts).toBe(3); // the failed attempt was retried too

      yield* Queue.offer(second, payload("B"));
      expect([...(yield* next(out)).types]).toEqual(["B"]);
      yield* Fiber.interrupt(fiber);
    }));
  });

  test("each run of the same stream value starts afresh: its first connection announces nothing, whatever an earlier run did", async () => {
    await Effect.runPromise(Effect.gen(function* () {
      const queues = [yield* Queue.unbounded<{ readonly payload: string }, SqlError>(), yield* Queue.unbounded<{ readonly payload: string }, SqlError>()];
      const { listen } = yield* fakeListen([queues[0]!, queues[1]!]);
      const stream = wakeupStreamFrom(listen, { retryBase: "10 millis" });

      const firstRun = yield* collect(stream);
      yield* Queue.offer(queues[0]!, payload("A"));
      yield* next(firstRun.out);
      yield* Fiber.interrupt(firstRun.fiber);

      // the same stream value, run again: this is a first connection, not a reconnect
      const secondRun = yield* collect(stream);
      yield* Queue.offer(queues[1]!, payload("B"));
      const batch = yield* next(secondRun.out);
      expect(batch.wildcard).toBe(false);
      expect([...batch.types]).toEqual(["B"]);
      yield* Fiber.interrupt(secondRun.fiber);
    }));
  });

  test("the delay before trying again doubles up to the maximum, and starts over after a connection that was established and lost", async () => {
    await Effect.runPromise(Effect.gen(function* () {
      const first = yield* Queue.unbounded<{ readonly payload: string }, SqlError>();
      const second = yield* Queue.unbounded<{ readonly payload: string }, SqlError>();
      const times: Array<number> = [];
      const { listen: inner } = yield* fakeListen([first, "fail", "fail", "fail", second]);
      const listen: typeof inner = Effect.suspend(() => { times.push(Date.now()); return inner; });
      const { out, fiber } = yield* collect(wakeupStreamFrom(listen, { retryBase: "20 millis", retryMax: "80 millis" }));
      yield* Queue.offer(first, payload("A"));
      yield* next(out);
      yield* Queue.fail(first, lost()); // established, then lost
      const reconnect = yield* next(out);
      expect(reconnect.wildcard).toBe(true);
      // attempts: 0 first connect; 1..3 failures; 4 the reconnect. Gaps: base after the lost connection, then 20 -> 40 -> 80 (the cap) between failures.
      const gaps = times.slice(1).map((t, i) => t - times[i]!);
      expect(gaps).toHaveLength(4);
      expect(gaps[0]!).toBeGreaterThanOrEqual(15);
      expect(gaps[1]!).toBeGreaterThanOrEqual(15);
      expect(gaps[2]!).toBeGreaterThanOrEqual(35);
      expect(gaps[3]!).toBeGreaterThanOrEqual(70);
      expect(gaps[3]!).toBeLessThan(400);
      yield* Fiber.interrupt(fiber);
    }));
  });

  test("the first connection announces nothing", async () => {
    await Effect.runPromise(Effect.gen(function* () {
      const first = yield* Queue.unbounded<{ readonly payload: string }, SqlError>();
      const { listen } = yield* fakeListen([first]);
      const { out, fiber } = yield* collect(wakeupStreamFrom(listen, { retryBase: "10 millis" }));
      yield* Queue.offer(first, payload("A"));
      const batch = yield* next(out);
      expect(batch.wildcard).toBe(false);
      yield* Fiber.interrupt(fiber);
    }));
  });
});
