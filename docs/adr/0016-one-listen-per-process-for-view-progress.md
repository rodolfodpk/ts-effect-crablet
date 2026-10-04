# ADR-0016: One LISTEN per process for view progress; a hub fans the pings out in memory

## Status

Accepted. Implemented in phases 1-3 (docs/plans/shared-listener.md); phase 4 re-measures.

## Context

A view's progress ping (`pg_notify('crablet_view_progress', …)`, ADR-0014) is consumed in two places, and each uses the database separately:

- **The live feed** (`GET /api/views/changes`, server-sent events) opens its own `PgClient.listen`, which reserves a connection from the pool for as long as the page is open. ADR-0014 recorded the consequence: one pooled connection per open page, so a few hundred pages exhaust a pool, and a pooler in transaction mode cannot serve it at all.
- **The wait of a consistent read** (`waitUntilProcessed`, ADR-0015) does not use the ping: it polls the view's progress every 25 ms, with up to two queries per poll. Measured in phase 7 (NOTES, ADR-0015 "Measured costs"): a waiting reader costs up to about 80 queries/s, past about 50 waiting readers on a pool of 10 the wait stretches, and a read that finds its view slightly behind pays a 25 ms floor (p95 36 ms against 7 ms for a read that does not wait).

Both are waiting for the same event, "a view's progress moved", which the database already announces once, after commit.

`PgClient.listen` (Effect 4.0.0, checked) holds a pooled connection until its scope closes, and **fails its notification queue with the original `SqlError` if the connection drops after `LISTEN` was confirmed**. So a consumer can see a drop and reconnect.

## Decision

1. **A `ViewProgressHub` service** (`@crablet/views`) holds ONE `LISTEN crablet_view_progress` for the lifetime of its layer and fans each ping out in memory to any number of subscribers. The database cost of live pages and of waiting readers no longer depends on how many there are.
2. **A subscriber keeps the latest ping per view it asked for, not a queue.** Each has a map of view to latest ping, a `resync` flag and a latch that wakes it. Memory is bounded by the number of views, and a slow consumer cannot lose "view X moved": at worst it sees the newest ping of X and not the older ones, which is all a hint says. (A sliding queue was rejected: a burst of pings for one view could push another view's last ping out before it was read.)
3. **A dropped connection is reconnected and announced.** The hub retries `LISTEN` with backoff (0.5 s, doubling, at most 30 s, as the page does) and, on every connect, including the first, flags every subscriber `resync`: a ping may have been missed, so re-read. While the hub is not connected, consumers fall back to polling.
4. **`waitUntilProcessed` uses the hub when one is provided** (an optional service: with none in the context it polls exactly as before, so tools and tests that do not build a hub are unchanged). It subscribes first, then loops: check progress; if behind, wait for a ping for that view or a safety interval (1 s), whichever comes first; a `resync` re-checks at once. The 25 ms floor and the polling load go away; a wait costs a query per ping, not 40 per second.
5. **`viewProgressFeed(names)` uses the hub instead of its own `LISTEN`.** It subscribes to the hub first and then reads the views' current cursors, which keeps ADR-0014's guarantee (nothing between the listener and the read is missed); a `resync` re-emits the current cursors. A feed no longer holds a database connection.
6. **One hub per process, provided where the app is built** (a `Layer` over `PgClient`), shared by the feed and the read wrapper so they share the connection. Several instances each hold their own `LISTEN`; `NOTIFY` reaches all of them.

## Alternatives considered

- **Keep a `LISTEN` per feed and size the pool for it.** The status quo. It caps open pages at roughly the pool size and does nothing for waiting readers.
- **A queue per subscriber that drops the oldest (`PubSub.sliding`).** Bounded, but it can drop the only ping of a quiet view behind a burst of another's. Coalescing by view cannot.
- **An external broker (Redis, NATS) for the ping.** Another system to run for a signal Postgres already sends after commit.
- **Wait by polling, with a longer interval.** Halves the load and raises the floor; does not remove either.

## Consequences

- **Live pages stop costing connections.** The limit that the scale envelope gave for open pages (a few hundred, from the pool) becomes memory and sockets. A deployment behind a pooler in transaction mode still needs the one `LISTEN` on a session connection, and only that one.
- **A wait is as fast as the ping**, not as fast as the next 25 ms tick, and a lagging view is checked once per ping, so the cost of many waiting readers stops growing with their number.
- **The ping stays a hint.** Correctness never depends on one: the wait re-checks on a safety interval and on every reconnect, and the feed re-reads on every connect (ADR-0014). The hub makes missed pings rarer and cheaper to recover from; it does not make them impossible.
- **A shared failure point, with a fallback.** If the hub's connection is down, every consumer is affected at once, and each falls back to polling (waits) or to re-reading on reconnect (feeds). The hub's state (`connected`) is observable.
- **Breaking for `viewProgressFeed`** (it now needs the hub, not `PgClient`), and for the apps' layers (they provide the hub). One commit updates every consumer (ADR-0013). `waitUntilProcessed` is not breaking.
- **Not changed:** the poller's own wake-up `LISTEN` (`crablet_events`, ADR-0005) is a separate channel and a separate listener, one per processor module; folding it in is possible but not part of this decision.
