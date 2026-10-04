# Plan: one LISTEN per process for view progress (ADR-0016)

## Context
[ADR-0016](../adr/0016-one-listen-per-process-for-view-progress.md): the live feed holds a pooled connection per open page, and the consistent read's wait polls every 25 ms. A `ViewProgressHub` holds one `LISTEN crablet_view_progress`, fans the pings out in memory, and both consumers use it. Measurements that motivate it are in NOTES ("Read consistency, phase 7").

## What exists (checked)
- `viewProgressFeed(names)` (`@crablet/views/ViewProgressFeed`): `pg.listen(VIEW_PROGRESS_CHANNEL)` per call, then `SELECT … FROM crablet_view_progress`, then the queue; used by `CourseFeedApiLive` and its tests (`course-feed.test.ts`, `view-progress-ping.test.ts` listens with a raw client).
- `waitUntilProcessed(subscription, write, { timeout, interval })` polls: progress row, `hasPendingSelectedEvents`, sleep `interval` (25 ms). Called through `waitForViews` by `ConsistentRead`, and by tests.
- `PgClient.listen` reserves a pooled connection until its scope closes; after `LISTEN` is confirmed a connection failure fails the queue with the `SqlError` (`PgConnection.ts`, Effect 4.0.0).
- The apps build one runtime (`Crablet.layer`) and one HTTP layer (`makeCourseApiLayer`, `makeWalletApiLayer`); the feed exists only in the course app.

## The phases
| | Phase | Value | Depends on | Commit |
|---|---|---|---|---|
| 1 | `ViewProgressHub`: coalescing subscribers, reconnect with backoff, resync (done) | the piece everything else uses | - | additive (new module) |
| 2 | `waitUntilProcessed` waits on the hub when one is provided (polls otherwise) (done) | removes the 25 ms floor and the polling load | 1 | additive |
| 3 | `viewProgressFeed` uses the hub; the apps provide it; a test that many open feeds hold ONE database connection (done) | removes the per-page connection | 1 | breaking for `viewProgressFeed` and the apps' layers |
| 4 | Re-measure with `bench-reads.ts`; update ADR-0014, ADR-0015 "Measured costs" and the scale envelope (done; it also found, and fixed, a thundering herd after a ping) | confirms the gain | 2, 3 | docs, a script change, and a small change to the wait |

Each phase ends green (`bun run typecheck`, `bun run test:unit`, and the integration suites in batches) and is committed on its own; push only on request.

## Phase 1. The hub - DONE (see NOTES "Shared listener, phase 1")
- `packages/views/src/ViewProgressHub.ts`: `ViewProgressHub` (a `Context.Service`), `makeViewProgressHub(options)`, `ViewProgressHubLive`. The notification source is a parameter (default `pg.listen(VIEW_PROGRESS_CHANNEL)`), so tests drive it with a fake queue and can fail it to simulate a drop.
- A subscription: `next` waits until there is a ping for a view it asked for, or a resync, and returns `{ pings, resync }` (pings coalesced to the latest per view); scoped, so closing the scope removes it.
- The run loop (forked in the layer's scope): listen, mark connected, flag every subscriber `resync`, take and decode pings until the queue fails or ends, mark disconnected, back off, repeat. An undecodable payload is dropped.
- Tests: unit (Bun, fake source): delivery and filtering, coalescing, `next` blocks until something arrives, resync on first connect and on reconnect, backoff schedule, a subscriber removed with its scope, a bad payload dropped. Integration (Node, real Postgres): a ping reaches subscribers; `pg_terminate_backend` of the hub's connection is followed by a reconnect and a resync, and pings flow again.

## Phase 2. `waitUntilProcessed` on the hub - DONE (see NOTES "Shared listener, phase 2")
- `Effect.serviceOption(ViewProgressHub)`: with a hub, subscribe to the view first, then loop check, wait for a ping (or the safety interval, default 1 s, or a resync), check again; without one, today's polling. A hub that is not connected counts as no hub (poll at `interval`).
- Tests: every existing `waitUntilProcessed` test passes unchanged without a hub and with one; with a hub a wait returns within a few milliseconds of the ping (not the next 25 ms tick) and issues far fewer queries than polling (counted with a wrapping `SqlClient`); the safety interval still ends a wait when no ping comes; a resync re-checks at once.

## Phase 3. The feed on the hub - DONE (see NOTES "Shared listener, phase 3")
- `viewProgressFeed(names)` requires the hub: subscribe, then read the current cursors, emit them, then emit pings as batches arrive; a resync re-emits the current cursors. No `PgClient`, no connection.
- `makeCourseApiLayer` builds the hub once (`ViewProgressHubLive`) and provides it to the feed and the query group; `startCourseAppForTest` and `index.ts` need nothing more. The wallet app has no feed but its read wrapper benefits: provide the hub there too.
- Tests: `course-feed.test.ts` unchanged in behavior; a new test opens 200 feeds and asserts the database's connection count stays small (a handful, not 200), and that a write reaches all of them; killing the hub's connection is followed by a resync and a re-emitted opening cursor on every feed.

## Phase 4. Re-measure - DONE (see ADR-0016 "Measured results" and NOTES "Shared listener, phase 4")
`bench-reads.ts` scenarios 2 and 3 again (the p95 floor under writes; the cost and latency of many waiting readers), plus a new scenario: N open feeds and the connection count. Update the numbers in ADR-0015 "Measured costs" and ADR-0014's consequence, and the scale envelope's live-pages limit.

## Risks
- A missed ping between the initial check and the wait: the subscription is created BEFORE the first check, so a ping that arrives meanwhile is already in it.
- A hub that is "connected" but silent (a half-open TCP connection): the safety interval and the feed's re-read on reconnect are the net; a periodic no-op `NOTIFY` heartbeat to detect it is possible and not part of this plan.
- `Latch`/subscriber races: a ping can open a latch whose batch was already taken, giving one empty wake; `next` loops until it has something, so callers never see an empty batch.
- One hub per process: two hubs in one process would hold two connections; the layer is a single value shared by everything that needs it (Effect memoizes it per build).

## Not in this plan
The poller's own `crablet_events` wake-up listener (one per module), a heartbeat to detect a silent connection, and leader fencing.
