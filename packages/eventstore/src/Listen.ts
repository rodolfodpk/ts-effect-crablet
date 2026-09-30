import { Duration, Effect, Stream } from "effect";
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
// CAVEAT: there is no automatic reconnect-with-backoff if the LISTEN connection drops. A production
// deployment would wrap this stream in retry/reconnect logic (e.g. `Stream.retry(Schedule...)`); the
// pollers' periodic polling is the safety net meanwhile.

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

export const wakeupStream = (
  pg: PgClient.PgClient,
  channel: string
): Stream.Stream<WakeupBatch, SqlError> =>
  // `pg.listen` yields the notification queue once Postgres confirms LISTEN (holding a dedicated
  // connection for the stream's lifetime); `Stream.fromQueue` + `Stream.unwrap` turn that into a stream.
  Stream.unwrap(Effect.map(pg.listen(channel), Stream.fromQueue)).pipe(
    Stream.map((notification) => decodePayload(notification.payload)),
    // `Stream.groupedWithin(maxSize, duration)` is the debounce/coalesce technique: it buffers
    // elements into an array and flushes the buffer whenever EITHER `maxSize` elements have
    // arrived OR `duration` has elapsed since the last flush - whichever comes first. Passing
    // `Number.MAX_SAFE_INTEGER` for size effectively disables the size trigger, leaving pure
    // time-based batching: every NOTIFY that arrives within the same 20ms window gets merged into
    // one `WakeupBatch` instead of dispatching N separate wakeups.
    Stream.groupedWithin(Number.MAX_SAFE_INTEGER, Duration.millis(DEBOUNCE_MS)),
    Stream.filter((batch) => batch.length > 0),
    Stream.map(mergeBatch)
  );

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
