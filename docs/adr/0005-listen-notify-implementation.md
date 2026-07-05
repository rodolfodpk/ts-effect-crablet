# ADR-0005: LISTEN/NOTIFY built on PgClient.listen + pg_notify() SQL function

## Status

Accepted (Phase 0)

## Context

`@effect/sql-pg`'s `PgClient.listen(channel)` already implements the "dedicated non-pooled
connection" pattern Java's `PostgresNotifyWakeupSource` uses by hand — a ref-counted (`RcRef`)
`new Pg.Client(pool.options)` separate from the pool, returning a `Stream<string, SqlError>` of
raw payloads. No raw `pg.Client` EventEmitter bridging was needed for the subscribe side.

However, `PgClient.notify(channel, payload)` (v0.52.1) is broken for any non-literal payload: it
runs `NOTIFY <channel>, $1` with the payload as a bind parameter, but Postgres's `NOTIFY` command
syntax only accepts a string *literal* for the payload, not a parameter placeholder — confirmed
directly against Postgres (`NOTIFY test_channel, $1` → `syntax error at or near "$1"`, SQLSTATE
`42601`). The `pg_notify()` *function* form (already used by `append_events_if()` itself) accepts a
bind parameter correctly.

Separately, `PgClient`'s internal `onListenClientError` handler is a no-op: there is no automatic
reconnect-with-backoff on a dropped LISTEN connection, unlike Java's explicit exponential backoff
(`1000 << attempt`, capped at 60000ms, resetting after success).

## Decision

Consume `PgClient.listen(channel)`'s built-in stream as-is for subscribing. For publishing, never
call `PgClient.notify()` — instead notify via raw ``sql`SELECT pg_notify(${channel}, ${payload})` ``
(the `notify` export in `src/listen.ts`). Accept the missing reconnect-with-backoff behavior as a
known limitation for now rather than building a custom retry wrapper.

## Consequences

- Any code that needs to publish a notification must use the `notify()` helper in `listen.ts`, not
  `PgClient.notify()` directly — the latter will throw a Postgres syntax error for any non-literal
  payload.
- Debounce/coalescing (`Stream.groupedWithin(Number.MAX_SAFE_INTEGER, Duration.millis(20))`) is
  verified to coalesce a burst of notifications into a single dispatch with the union of
  types/tag-keys, mirroring Java's `PostgresNotifyWakeupSource` batching semantics — this rides on
  top of the same `listen()` stream, unaffected by the `notify()` workaround.
- A dropped LISTEN connection currently has no automatic recovery. A production port would need to
  wrap `.listen()`'s stream in retry/reconnect logic; this is deferred, not solved, and should be
  revisited before treating any consumer as production-hardened.
