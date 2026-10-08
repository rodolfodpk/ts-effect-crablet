import { Duration, Effect, Queue, Ref, type Scope, Stream } from "effect";
import type { PgClient } from "@effect/sql-pg";
import type { SqlError } from "effect/sql/SqlError";
import { decodePayload, type DecodedPayload } from "./NotifyPayload.ts";

// LISTEN + 20ms debounce/coalesce: turns the raw NOTIFY payloads into batched wakeups.
//
// `PgClient.listen(channel)` already implements the "dedicated non-pooled connection" pattern: it
// holds a connection separate from the query pool for as long as the returned scope lives, and yields
// a queue of notifications once Postgres confirms LISTEN. No raw pg client / EventEmitter bridging is
// needed. To publish, use `PgClient.notify(channel, payload)` (it accepts a dynamic payload).
//
// The stream reconnects by itself (see `wakeupStreamFrom`); the pollers' periodic polling stays the safety net while it is away.

// PATTERN PRIMER - `Stream<A, E, R>`, Effect's model for "more than one value over time," the
// counterpart to `Effect<A, E, R>`'s "exactly one value" (or none, on failure). Think of it as a
// resource-safe, interruptible, backpressure-aware async generator: like Node's
// `AsyncIterable<A>`, but every operator (`.map`, `.filter`, `.groupedWithin` below) composes
// lazily into a new `Stream` description without consuming anything, the same way `Effect`
// combinators compose without running anything, until something actually pulls from it
// (`Stream.runForEach`, used in event-poller's `EventProcessor.ts`). `pg.listen(channel)` (used
// below) is the source: each Postgres NOTIFY becomes one `A` flowing through the stream.
export interface WakeupBatch {
  readonly wildcard: boolean;
  readonly types: ReadonlySet<string>;
  readonly tagKeys: ReadonlySet<string>;
}

const DEBOUNCE_MS = 20;

export type ListenSource = Effect.Effect<Queue.Dequeue<{ readonly payload: string | null }, SqlError>, SqlError, Scope.Scope>;

export interface WakeupOptions {
  // Delay before LISTEN is retried: `retryBase`, doubling after each failed attempt up to `retryMax`; back to `retryBase` after a connection
  // that was established and then lost. Defaults 500 ms / 30 s.
  readonly retryBase?: Duration.Input;
  readonly retryMax?: Duration.Input;
}

const WILDCARD: DecodedPayload = { wildcard: true, types: new Set(), tagKeys: new Set() };

// The stream never ends and never fails: when the LISTEN connection is lost (or cannot be made) it waits, with backoff, and listens again. After
// every RE-connect it emits one wildcard wakeup, because notifications sent while it was away are gone for good: the poller must look at the log
// itself. (The first connect announces nothing; the poller's first tick reads the log anyway.) Before this, a lost connection ended the stream and
// the poller stayed on its polling interval for good (docs/plans/reliability-and-scale-diagnostic.md, D3).
export const wakeupStreamFrom = (listen: ListenSource, options: WakeupOptions = {}): Stream.Stream<WakeupBatch, SqlError> => {
  const retryBase = Duration.toMillis(Duration.fromInputUnsafe(options.retryBase ?? "500 millis"));
  const retryMax = Duration.toMillis(Duration.fromInputUnsafe(options.retryMax ?? "30 seconds"));

  // The state of a run lives IN the run (created when the stream starts), not in the stream value: a stream is a recipe that can be run again, and each run is its own
  // first connection. (Before, these were `let` variables captured by the stream value, so a second run of the same value thought it was reconnecting.)
  return Stream.unwrap(
    Effect.gen(function* () {
      const delay = yield* Ref.make(retryBase);
      const connectedOnce = yield* Ref.make(false);
      const connected = yield* Ref.make(false);

      // One connection's life; ends, without failing, however it ended.
      const connection: Stream.Stream<DecodedPayload> = Stream.unwrap(
        Effect.gen(function* () {
          const queue = yield* listen;
          yield* Ref.set(connected, true);
          const reconnect = yield* Ref.getAndSet(connectedOnce, true);
          const notifications = Stream.map(Stream.fromQueue(queue), (n) => decodePayload(n.payload));
          return reconnect ? Stream.concat(Stream.make(WILDCARD), notifications) : notifications;
        })
      ).pipe(Stream.catchCause(() => Stream.empty));

      // Wait before the next attempt: `retryBase` after a connection that was established and then lost; otherwise the current delay, which doubles up to `retryMax`.
      const pause: Stream.Stream<never> = Stream.drain(
        Stream.fromEffect(
          Effect.gen(function* () {
            const wasConnected = yield* Ref.getAndSet(connected, false);
            const current = yield* Ref.get(delay);
            yield* Ref.set(delay, wasConnected ? retryBase : Math.min(current * 2, retryMax));
            yield* Effect.sleep(Duration.millis(wasConnected ? retryBase : current));
          })
        )
      );

      return Stream.forever(Stream.concat(connection, pause)).pipe(
        // `Stream.groupedWithin(maxSize, duration)` is the debounce/coalesce technique: it buffers elements into an array and flushes the buffer
        // whenever EITHER `maxSize` elements have arrived OR `duration` has elapsed since the last flush - whichever comes first. Passing
        // `Number.MAX_SAFE_INTEGER` for size effectively disables the size trigger, leaving pure time-based batching: every NOTIFY that arrives
        // within the same 20ms window gets merged into one `WakeupBatch` instead of dispatching N separate wakeups.
        Stream.groupedWithin(Number.MAX_SAFE_INTEGER, Duration.millis(DEBOUNCE_MS)),
        Stream.filter((batch) => batch.length > 0),
        Stream.map(mergeBatch)
      );
    })
  );
};

export const wakeupStream = (
  pg: PgClient.PgClient,
  channel: string,
  options: WakeupOptions = {}
): Stream.Stream<WakeupBatch, SqlError> => wakeupStreamFrom(pg.listen(channel), options);

function mergeBatch(payloads: ReadonlyArray<DecodedPayload>): WakeupBatch {
  if (payloads.some((p) => p.wildcard)) {
    return { wildcard: true, types: new Set(), tagKeys: new Set() };
  }
  const types = new Set<string>();
  const tagKeys = new Set<string>();
  for (const p of payloads) {
    for (const t of p.types) types.add(t);
    for (const k of p.tagKeys) tagKeys.add(k);
  }
  return { wildcard: false, types, tagKeys };
}
