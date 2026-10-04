# ADR-0014: Live updates are a ping, sent after the commit, delivered at most once

## Status

Accepted.

## Context

A read that carries the writer's marker (`?consistentWith=<marker>`, ADR-0015; this ADR was written when it was `?waitFor=<view>` on the command) makes the writer's own next read fresh. Nothing told a *different* client (a second tab, another user) that a view had changed, except polling. Views advance in a background processor, so the moment to tell is when a view's progress commits.

## Decision

1. **The signal is a ping, not data.** When a view's progress advances, the tracker sends `pg_notify('crablet_view_progress', {id, transactionId, position})`: which view, and its new cursor (ADR-0012). It carries nothing from the events. A client that hears it asks the API (the same read endpoints, with their own authorization and shape). So the signal needs no schema per view, leaks no row data, and cannot disagree with the read.
2. **Sent after the commit, by construction.** The cursor UPDATE and the `pg_notify` are one statement, so Postgres delivers the notification only if the progress commit succeeds. A failed batch rolls back and sends nothing, so a ping never announces data the view does not have. Opt-in per tracker (`notifyChannel`); views turn it on, automations and the outbox do not.
3. **At most once, and that is enough.** A notification is not stored. A listener that was not connected misses it. Correctness never depends on one: the feed (`GET /api/views/changes`, server-sent events, one connection for several views) **opens with each view's current cursor**, read after the listener is confirmed, so a client reads once on every (re)connect and cannot stay stale after a gap. Bursts are merged on the page (debounce), because pings are cheap and reads are not.
4. **Connections are bounded.** The server ends each after a maximum lifetime (5 minutes) and the client reconnects with exponential backoff (0.5 s, doubling, at most 30 s; a connection that delivered resets it). Shutdown waits for open feeds only up to `gracefulShutdownTimeout`.
5. **The cursor in the ping is comparable with the write's.** The command response carries `lastTransactionId` beside `lastPosition` (additive, ADR-0013), so a client holding its write's marker can tell a ping covers it.

## Alternatives considered

- *Send the changed rows (push the data).* Needs a schema and authorization per view, duplicates the read model, and a missed message loses data. Rejected for a hint that is safe to lose.
- *Poll.* Works, costs a request per client per interval whether or not anything changed.
- *Notify before commit, or from the event append.* Tells clients about events a view has not applied yet: they read, find nothing new, and miss the later change.
- *WebSocket.* More machinery for a one-way signal; SSE is plain HTTP, typed by the HttpApi definition, and the derived client consumes it.

## Consequences

- ~~One LISTEN connection per open feed~~ Superseded by [ADR-0016](0016-one-listen-per-process-for-view-progress.md): the feed subscribes to a hub that holds one LISTEN per process, so an open page costs memory, not a pooled connection (the course app's test opens 200 feeds on a pool of 10). The hub reconnects a lost LISTEN and every feed then says where the views are again.
- A production reverse proxy must not buffer the stream (`X-Accel-Buffering: no`, or `proxy_buffering off`). Not verified in a real browser in this repository's environment.
- Only the course app has a feed so far; the wallet has none. The pieces (`ViewProgressFeed`, the ping schema) are reusable.
