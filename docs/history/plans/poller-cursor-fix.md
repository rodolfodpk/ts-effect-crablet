# Plan: fix the pollers' skipped-event hole - move the progress cursor to (transaction_id, position)

> Note (ADR-0015): `?waitFor=<view>` on the command API, mentioned below, was replaced by the write's marker and reads that carry it (`?consistentWith=`). This plan is the record of the work as it was.

**Status:** done (the DCB conflict check and the pollers both moved to a `(transaction_id, position)` cursor; see ADR-0012). Kept as the record; its "What exists" section describes the code BEFORE the change.

## Context
A stress test found that the pollers' cursor logic can PERMANENTLY SKIP events under concurrent writers: 16 writers x 1500 appends (24,000 events, different tags so the V5 locks do not serialize them) and a reader doing `position > cursor AND transaction_id < pg_snapshot_xmin(...) ORDER BY position LIMIT 50` - the shape of
`event-poller/src/internal/sql.ts` - missed 11-22 events per run (0.05-0.09%) in 3 runs on both write paths (`append_events_batch`, and the real `append_events_if`). The same loop keyed on `(transaction_id, position)` missed 0 of 72,000. This affects views, the outbox and automations (all three use `event-poller`). The log API plan
(`event-log-api.md`) needs the same cursor, so this fix comes first and the log API reuses it.

Mechanism: `position` is assigned by `nextval` at insert, `transaction_id` when the transaction first writes. Two transactions can receive them in opposite orders. If the transaction with the LOWER xid but HIGHER position commits first while the other is still open, it is visible below the xmin, the cursor jumps past the open transaction's lower position, and when that transaction
commits its event is behind the cursor forever. A keyset on `(xid, position)` is safe because any row that appears later has an xid greater than every xid already below the xmin (xids are assigned in increasing order, and any transaction that takes an xid later gets one above the current counter). It also matches the order `queryEvents` already uses for model loads (`ORDER BY transaction_id, position`).

## What exists (verified)
- Cursor today is a bare position: `EventFetcher.fetchEvents(id, lastPosition: bigint, batchSize)`, `ProgressTracker.getLastPosition / updateProgress(id, position)`; `EventProcessor.process` fetches after `lastPosition` and then `updateProgress(id, events[last].position)`.
- The fetch query (`event-poller/src/internal/sql.ts`, `buildEventSelectionQuery`) is `e.position > $1 AND e.transaction_id < pg_snapshot_xmin(...) AND <selection> ORDER BY e.position LIMIT n`; `StoredEvent` already carries `transactionId` and `position`.
- Progress tables (`crablet_view_progress`, `crablet_automation_progress`, `crablet_outbox_topic_progress`) store `last_position BIGINT`; the outbox has its own hand-rolled tracker (`outbox/src/internal/OutboxProgressTracker.ts`); `PostgresProgressTracker` serves views and automations.
- `crablet_events.position` is `BIGSERIAL` (an explicit position can be inserted: needed for a deterministic reproduction); index `(transaction_id, position)` exists.
- Other users of the position cursor: `ProcessorManagementService` (lag = `MAX(position) - lastPosition`, `reset` does not rewind), `waitUntilProcessed` / `hasPendingSelectedEvents` (compare a view's progress position with a write's position), `ExecutionResult.lastPosition`, `ViewWaiter` and the HTTP `?waitFor` handler, the in-memory test fixtures (`InMemoryProgressTracker`, `InMemoryEventFetcher`), many tests.

## Decisions
1. **Cursor = `{ transactionId: string, position: bigint }`** (`ProgressCursor`, exported from `@crablet/event-poller`). Order everywhere: `ORDER BY transaction_id, position`; fetch condition `(transaction_id, position) > ($xid::xid8, $pos::bigint) AND transaction_id < xmin`. The initial cursor is `{ "0", 0n }`.
2. **Progress tables gain `last_transaction_id xid8 NOT NULL DEFAULT '0'`** (new migration V8), kept next to `last_position` (still written, still used for lag display and ops). Existing rows are backfilled SAFELY, not from the event at `last_position` alone: under the old cursor an event with a LOWER xid but a HIGHER position than `last_position` is still undelivered, and a cursor built from the xid at `last_position` would put it behind the new cursor forever (the same bug, reintroduced by the migration). So the backfilled cursor is
   `(LEAST(xid of the event at last_position, MIN(xid of events with position > last_position)), 0)`: it may redeliver a few events (handlers are at-least-once), never skips one. When `last_position = 0` the cursor is `('0', 0)`. When the event at `last_position` no longer exists (events are never deleted today) the backfill uses the MIN(xid of later events) alone, and the migration notes say a gap would replay from there.
   Events a deployment already skipped before this fix cannot be found automatically; the docs say how to recover (reset the processor's cursor to zero and let it re-deliver - handlers are at-least-once and must already be idempotent).
3. **Interfaces change (packages are unpublished, so no shim):** `EventFetcher.fetchEvents(id, cursor, batchSize)`; `ProgressTracker.getCursor(id)` / `updateCursor(id, cursor)` (replacing `getLastPosition` / `updateProgress`); `EventProcessor` derives the new cursor from the last event of the batch.
4. **Waiting must compare cursors, not positions.** Under keyset order a view whose cursor position is HIGHER than a write's position may still not have processed that write (the inversion case), so "progress.position >= write.position" is wrong. `waitUntilProcessed` takes the write as `{ position, transactionId }` and compares `(xid, position)` lexicographically;
   `hasPendingSelectedEvents` uses the same pair comparison. `ExecutionResult` gains `lastTransactionId` (from `AppendResult.transactionId`, already returned by `append`); `ViewWaiter` receives the write pair; the HTTP response keeps `lastPosition` (a string) and the handler passes both to the waiter. README / tutorial snippets updated.
5. **Delivery order changes slightly and deliberately:** across transactions, events are delivered in transaction-id order instead of strict position order (within a transaction, position order). This is the order model loads already use, and it preserves causality WHEN a transaction writes nothing before its reads (its xid is then assigned at the append, after it read the other's committed events, so it is higher). The exception: a command whose `prepare` appends before the model loads gets its xid early, so its events can be delivered before those of a transaction it later read. This is documented in the ADR; the guarantee is per-boundary consistency (the DCB condition), not global causal delivery order.
6. The log API (`event-log-api.md`) uses this exact cursor and read function; the store gets one shared keyset-read helper (event-log phase 1) that the poller fetch can reuse where practical.

## Phases (each ends green: `bun run typecheck`, `bun run test:unit`, `bun run test:integration`; commit per phase; push only on request)
### 1. A deterministic reproduction FIRST (0.5 day)
Integration test in `packages/event-poller/test/integration/` (new file, real Postgres): connection T1 `BEGIN; SELECT pg_current_xact_id()` (takes the LOWER xid, x1); connection T2 `BEGIN; SELECT nextval('crablet_events_position_seq')` (reserves position p2; `nextval` itself assigns T2 an xid, x2 > x1, so T2 is in flight); T1 inserts a row (default position p1 > p2) and commits - xmin is now x2, so the row is visible; a reader using the CURRENT logic (position cursor + xmin rule) fetches it and advances to p1;
T2 then inserts its row with the explicit position p2 (xid x2) and commits; the reader's next fetch must return p2. (Implemented in `packages/event-poller/test/integration/cursor-inversion.test.ts`; against today's code it fails at that last assertion, with the setup assertions passing.) With today's code it does not: the test FAILS (it is the bug, shown). Written first, committed failing is not allowed on green builds: it is added in the same commit as the fix, with the first version proven failing locally before the fix is applied (recorded in the commit message).
**Phase 1 result:** `packages/event-poller/test/integration/cursor-inversion.test.ts` failed at its last assertion (the skipped row is never delivered), and `packages/eventstore/test/integration/append-cursor-inversion.test.ts` failed too: the DCB conflict check had the same hole. With writer T1 (lower xid, higher position) committed and writer T2 (higher xid, lower position, in flight) committing after the command loaded, the command's append succeeded although an event of its boundary had committed before the append and was never seen. Reachable after V5's writer-side locks too: writers lock their own `(type, tag)` pairs, so writers of DIFFERENT event types of one boundary (e.g. `DepositMade` and `WithdrawalMade` of one wallet) do not serialize, and the model load takes no lock. (The earlier assumption that only overlapping-but-different boundaries were exposed was wrong.)

### 2b. The conflict-check cursor - DONE (before the poller work, since it is a consistency bug)
- `V7__crablet_append_condition_xid_cursor.sql`: `append_events_if` gains `p_after_cursor_transaction_id XID8` (NULL = old position-only comparison); `crablet_items_match_any` compares `(transaction_id, position) > (xid, position)`; the caller's OWN transaction is ignored by the concurrency check (a command's `prepare` appends are part of what it loaded). The progress migration is therefore V8, not V7.
- The model load (`EventStore.project`) reads `transaction_id < pg_snapshot_xmin(...)` per row and advances the returned cursor only over SETTLED events: anything that becomes visible later has an xid at or above that xmin, so it sorts after the cursor. Events the load saw but that were not yet settled sit above the cursor and are reported as a conflict (the command retries and reloads them settled): safe, at the price of an occasional spurious `Conflict` while an older transaction is open.
- `queryEvents(after)` compares pairs for a cursor that has a transaction id; the executable spec (`spec/Spec.ts`) compares `(transactionId, position)`. The in-memory store needs no change (its position and transaction id are both monotone).
- Tests: the phase 1 test passes, plus "an event loaded before it settled is a conflict; the reload settles it and the retry succeeds". Full integration suite: green except the poller test below.

Also a smaller probabilistic smoke (8 writers x 300) asserting zero missed events after the fix (it cannot prove absence on its own; the deterministic test is the gate).
### 2. The migration (0.25 day)
`V8__crablet_progress_transaction_cursor.sql` in `packages/db-migrations`: add the column to the three progress tables, backfill, comments; add it to `migrationFiles`. Test (apply the backfill UPDATE to prepared rows): the ordinary case gives the xid at the old position; the INVERSION case (an undelivered event with a lower xid and a higher position than `last_position`) gives a cursor at or below that event's xid so it is still delivered; `last_position = 0` gives `('0', 0)`.
### 3. The query, the interfaces and the trackers (1 day)
- `event-poller/src/internal/sql.ts`: replace the header comment (it claims the xmin filter alone prevents skipped rows; it does not), then the keyset condition and `ORDER BY transaction_id, position` in `buildEventSelectionQuery`; `buildPendingSelectionQuery` compares pairs.
- `EventFetcher`, `ProgressTracker`, `PostgresProgressTracker` (`last_transaction_id::text` out, `$n::xid8` in; `updateCursor` writes both columns), `EventProcessor` (cursor in, last event's pair out), `SqlEventFetcher`; the views / automations / outbox fetchers (`ViewEventFetcher`, `AutomationEventFetcher`, `OutboxEventFetcher`); `OutboxProgressTracker` (hand-rolled SQL, same columns); `ProcessorManagementService` (lag stays position-based; reset semantics unchanged).
- Test doubles: `InMemoryProgressTracker`, `InMemoryEventFetcher` (cursor ordering by `(transactionId, position)` as strings compared numerically).
### 4. Waiting and the command result (0.5 day)
`ExecutionResult.lastTransactionId`; `CommandExecutor` fills it; `waitUntilProcessed(subscription, write, opts)` with pair comparison; `hasPendingSelectedEvents` pair bounds; `ViewWaiter` signature `(write: { position, transactionId }, { timeout })`; `CommandApiLive` passes the pair; wallet and course wait maps adapt; HTTP responses unchanged. Tests: the inversion case for waiting (a cursor with a higher position but an earlier pair must NOT count as caught up), existing wait tests, the e2e `?waitFor` flows.
### 5. Docs and the ADR (0.25 day)
ADR-0007 addendum (or ADR-0012 if it reads better): the skipped-event hole, the measurement, the fix, the changed delivery order and the recovery recipe for already-skipped events; NOTES entry; README `waitUntilProcessed` snippet; the stress script's method described (not committed as a test).
Then update `event-log-api.md` (its cursor is this one; its phase 1 shares the keyset read).

## Design diagrams: current, the problem, the new design

### 1. Current design
```text
 WRITERS (many concurrent transactions)                 STORE                          POLLER (views / outbox / automations)
 ───────────────────────────────────────                ─────                          ─────────────────────────────────────
 T1 ─┐  append_events_batch                          crablet_events                    fetch:
 T2 ─┼─▶ 1. xid      = pg_current_xact_id()  ──▶     ┌────────────────────┐            WHERE position > cursor
 T3 ─┘   2. position = nextval(seq)  (per row)       │ transaction_id xid8│              AND transaction_id < xmin
         3. INSERT, later COMMIT                      │ position  BIGSERIAL│            ORDER BY position LIMIT n
                                                      └────────────────────┘                     │
         xid and position are taken at different                                                 ▼
         moments, so their orders can disagree          progress tables                cursor = last row's position
                                                        last_position BIGINT  ◀────────  (a bare number)
 xmin = oldest still-open xid in the whole database
```

### 2. The problem: how an event is lost for good
```text
 time ─────────────────────────────────────────────────────────────────────────────────────────────▶

 T-A  ── xid 11, nextval → pos 5 ───────── (still open) ───────────────────── INSERT row ── COMMIT
 T-B  ── xid 10 ──────── nextval → pos 6 ── INSERT ── COMMIT
                                                  │                                   │
 Poller                                           ▼                                   ▼
   xmin = 11 (T-A is the oldest open xid),        fetch: (xid 10, pos 6) is visible   T-A's row (pos 5, xid 11)
   so T-B's xid 10 is below it                    cursor := 6                         appears, but position 5 is
                                                                                       NOT > cursor 6
                                                                                           │
                                                                                           ▼
                                                                         LOST FOREVER (never fetched)

 T-B took the lower xid but the higher position; T-A the reverse. (nextval itself assigns the xid.)
 Measured: 11-22 events lost per 24,000 appends (0.05-0.09%). Views, outbox and automations all affected.
 Also: waitUntilProcessed compares positions, so it can say "caught up" for a write that was skipped.
 Unverified: append_events_if's conflict check (`position > cursor AND xid < xmin`) has the same shape;
             a missed conflict is possible with overlapping boundaries (phase 1 tests this).
```

### 3. New design
```text
 WRITERS (unchanged)                                    STORE                          POLLER
 ───────────────────                                    ─────                          ──────
 T1 ─┐  append (same as today)                      crablet_events                    fetch:
 T2 ─┼─▶ xid, position taken as before  ──────▶     ┌────────────────────┐            WHERE (transaction_id, position) > cursor
 T3 ─┘                                               │ index (xid, pos) ✔ │              AND transaction_id < xmin
                                                      └────────────────────┘            ORDER BY transaction_id, position LIMIT n
                                                                                                │
                                                     progress tables                            ▼
                                                     last_position       (kept, for lag)  cursor = { transactionId, position }
                                                     last_transaction_id (NEW, V8)  ◀───── of the last row delivered

 WHY IT CAN'T SKIP:  every xid below xmin is finished and its rows are all visible.
                     Any row that appears later has an xid >= the old xmin, which is greater than any xid
                     already delivered, so it sorts AFTER the cursor.

 Same scenario as diagram 2:   cursor <- (10, 6) after T-B.   T-A's row arrives as (11, 5).
                               (11, 5) > (10, 6)  ✔   delivered.
```

### 4. What changes
```text
                          BEFORE                              AFTER
 cursor                   position (bigint)                   (transactionId, position)
 fetch order              position                            transaction_id, position (the order model loads use)
 progress tables          last_position                       + last_transaction_id (V8, safe backfill)
 ProgressTracker          getLastPosition / updateProgress    getCursor / updateCursor
 waitUntilProcessed       progress.position >= write.position progress.(xid, pos) >= write.(xid, pos)
 ExecutionResult          lastPosition                        + lastTransactionId
 delivery order           strict position order               by xid across transactions, by position within one
 skipped events           possible, silent                    none (0 of 72,000 in the stress test)
 kept as is               at-least-once delivery, idempotent handlers, the xmin stall on any open transaction
 caveat                   --                                  commands that append in `prepare` before reading can be
                                                              delivered before events they later read
```
The conflict-check cursor in `append_events_if` is not shown in the new design: if the phase 1 test finds a missed conflict, it moves to `(xid, position)` as well (V7).

## Notes on scope
- `crablet_module_scan_progress` and `crablet_processor_scan_progress` also hold position cursors but nothing in `packages/*/src` reads them: they are unused and are left alone (the ADR says so).
- The xmin rule stalls delivery while ANY transaction in the database is open, including unrelated ones (an idle-in-transaction session blocks all pollers). This is unchanged by the fix; the ADR documents it and the operational advice (alert on long-running transactions).
- `event-log-api.md` is referred to above but is not in the repo yet; this plan is its prerequisite and should be committed first.

## Risks
| Risk | Mitigation |
|---|---|
| The fix changes delivery order across transactions | documented; it is the order model loads already use; causality is preserved except for commands that append in `prepare` before reading (documented); handlers are already at-least-once |
| Performance of the keyset fetch with a selective view | the `(transaction_id, position)` index exists and is used for the scan; measure a rare-type view before / after on the 24k-row data; no new index unless the plan regresses |
| `waitUntilProcessed` compared positions (now wrong) | pair comparison + the inversion test; all call sites updated (README, wallet, course, `ViewWaiter`) |
| The V8 backfill skipping undelivered inverted events | backfill with the LEAST of the xid at `last_position` and the MIN xid of later events; the inversion case is a migration test |
| Events already skipped in existing databases | cannot be detected automatically; recovery = reset the cursor and re-deliver (documented); a count of events below a cursor and not delivered is not knowable from the progress table alone |
| xid8 handling in the client library (binary codec) | already handled: transaction ids are read with `::text` and written with `::xid8` casts (as `queryEvents` does) |
| Broad change across three modules | phased commits; the existing integration suites for views, outbox and automations are the regression gate |

## Verification
`bun run typecheck`; `bun run test:unit` (fixtures, processor loop with cursor ordering, wait comparison); `bun run test:integration` (the deterministic inversion reproduction, the smoke, the migration backfill, views / outbox / automations suites, wallet and course e2e with `?waitFor`). Manual: re-run the 16-writer stress (script kept in the session scratchpad) against the fixed fetch loop: 0 missed over several runs.
CI green on push.

## Non-goals
Changing how events are stored or numbered; rewriting the event log's `position` semantics; recovering already-skipped events automatically; a general "exactly once" delivery (the pollers stay at-least-once).

## Size
About 2.5 days.
