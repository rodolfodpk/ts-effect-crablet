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
