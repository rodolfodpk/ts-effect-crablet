import { Chunk, Duration, Effect, Stream } from "effect";
import type { PgClient } from "@effect/sql-pg";
import type { SqlError } from "@effect/sql/SqlError";
import { decodePayload, type DecodedPayload } from "./NotifyPayload.ts";

// FINDING (Phase 0): @effect/sql-pg@0.52.1's own PgClient.notify(channel, payload) is broken for
// any non-literal payload - it runs `NOTIFY <channel>, $1` with the payload as a bind parameter
// (node_modules/@effect/sql-pg/dist/esm/PgClient.js:262-274), but Postgres's NOTIFY command syntax
// only accepts a string *literal* for the payload, not a parameter placeholder - confirmed via
// `NOTIFY test_channel, $1` failing with "syntax error at or near '$1'" (SQLSTATE 42601) against a
// real Postgres instance. The `pg_notify(channel, payload)` *function* form (used by
// append_events_if() itself, and by this helper) does accept a parameter correctly. Use this
// instead of `PgClient.notify` for any dynamic payload.
export const notify = (pg: PgClient.PgClient, channel: string, payload: string): Effect.Effect<void, SqlError> =>
  Effect.asVoid(pg`SELECT pg_notify(${channel}, ${payload})`);

// Port of PostgresNotifyWakeupSource.java's LISTEN + 20ms debounce/coalesce behavior.
//
// Verified finding (Phase 0): @effect/sql-pg's PgClient.listen(channel) ALREADY implements the
// "dedicated non-pooled connection" pattern Java uses (see node_modules/@effect/sql-pg/dist/esm/
// PgClient.js:215-231 - a ref-counted `new Pg.Client(pool.options)` separate from the pool,
// via RcRef), and returns a Stream<string, SqlError> of raw notification payloads. No raw
// pg.Client EventEmitter bridging was needed for the subscribe path - this contradicts the
// original assessment's assumption that @effect/sql-pg "likely doesn't wrap LISTEN/NOTIFY".
//
// CAVEAT recorded for Phase 0 findings: the library's `onListenClientError` handler
// (PgClient.js:214) is a no-op - there is no automatic reconnect-with-backoff on connection drop,
// unlike Java's explicit exponential backoff (1000ms << attempt, capped 60000ms, resetting after
// success). For production parity this stream would need to be wrapped in retry/reconnect logic
// (e.g. Stream.retry(Schedule...)), which the current `.listen()` primitive does not provide.

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
  pg.listen(channel).pipe(
    Stream.map(decodePayload),
    Stream.groupedWithin(Number.MAX_SAFE_INTEGER, Duration.millis(DEBOUNCE_MS)),
    Stream.filter((chunk) => Chunk.isNonEmpty(chunk)),
    Stream.map((chunk) => mergeBatch(Chunk.toReadonlyArray(chunk)))
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
