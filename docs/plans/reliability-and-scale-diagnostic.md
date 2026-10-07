# Diagnostic and plan: reliability and scale gaps (2026-10-04, status updated 2026-10-06)

**Status:** steps 1-4 are **done and committed** (F1-F4 addressed, each checked by re-running its experiment: see "Results of the fixes"); steps 5 (event evolution, ADR-0017, **Proposed**, not built) and 6 (storage visibility and retention) are **not started**. The Data sections below are the diagnosis as it was **before** the fixes, kept as measured; the "after" figures are in "Results of the fixes". The experiments are re-runnable scripts (below).

## Why this exists
The architecture review (in the conversation, from reading the code) named several gaps: a leader that is not fenced, an unprotected wake-up listener, no snapshots, no event versioning, no retention. This document replaces those opinions with measurements: what is actually broken, how badly, and in what order to fix it.

## Method
- Real Postgres 18 (Testcontainers), the real `EventProcessor`, `tryAcquireGlobalLeader`, `wakeupStream`, `CommandExecutor` and event store. No mocks of the parts under test.
- One laptop (8 cores, Docker), everything on it. Numbers are for comparing and for order of magnitude, not capacity.
- Each experiment prints `DIAG` lines. The scripts: `packages/event-poller/diagnostics/leader-and-listener.diagnostic.ts` (D1, D1b, D1c, D2, D3, D3b, D4), `packages/commands/diagnostics/boundary-and-storage.diagnostic.ts` (E5, E5b, E5c, E5d, E5e, E7, E8) and `packages/commands/diagnostics/snapshot-write-spike.diagnostic.ts` (how a snapshot can be written, ADR-0018). Run with `node --test <file>` (add `--test-name-pattern="D3b"` to pick one); they are outside the test globs, so CI does not run them.
- **How firm each number is.** D1 and D3 are one run each. D1b is six trials (one per phase of the retry cycle) and was re-run after the scripts were moved, with the same shape. E5 is 25 commands per size. E8 was run twice (476 bytes per event both times; the append rate varied between 18,000 and 22,000/s). D2, D3b, D4 and E7 are yes/no observations. Each claim below says whether it is **measured**, **derived** (arithmetic from a measurement or a config value) or **from the code** (read, not run).
- One of my own experiment mistakes was caught on the way and is not in the data: D1b first measured only one phase of the retry cycle (every trial killed the leader at the same point, so every trial showed about 3.6 s), and was rerun with the kill time varied.

## Data

### D1 - the leader's database session is killed while events keep arriving
Two processors (A, B) on one lock and one progress row, leader retry interval 30 s (what both example apps and the library default used **at the time**; the default is 5 s since step 3), a write every 50 ms. At t=0 the session holding the advisory lock is terminated with `pg_terminate_backend`.

| Measured | Result |
|---|---|
| The old leader after losing the lock | **kept handling events for the whole 40 s window: 723 handler calls, last call at +40.0 s** |
| The other instance's first handled event | +27.1 s (its next retry) |
| Events handled by BOTH instances after the kill | **232 of 728 (32 %)**, and it continues for as long as both run |
| Longest gap between any two handler calls | 0.2 s (the zombie hid the failure) |
| Progress cursor sampled every 20 ms (1,991 samples) | 0 moved backwards in this race |

### D2 - can the cursor be written backwards?
`updateCursor(900)` then `updateCursor(100)`: the cursor reads back **100**. There is no guard. (D1 did not hit it; D2 shows nothing prevents it.)

### D1b - the leader process dies (session gone, fibers gone), follower retry interval 5 s
Takeover after the kill, with the kill moved through the follower's retry cycle: **4.2, 3.4, 2.5, 1.8, 0.9, 0.2 s** (mean 2.2 s; a re-run gave 4.2, 3.4, 2.6, 1.8, 1.0, 0.1): the takeover time is the retry interval minus the phase, uniform in (0, retry interval]. **Derived** for the apps' 30 s interval: 0 to 30 s of no processing, about 15 s on average (the only 30 s observation, D1's, was +27.1 s, for a killed session). Every module that has a leader is affected the same way (views, outbox, automations), from the code. (Emulated: the session was terminated and the processor's fibers stopped; not an OS-level `kill -9`.)

### D3 - the poller's `crablet_events` LISTEN session is killed
Poll 1 s, backoff after 3 empty polls (x2, up to 30 s), 25 s idle, then one write:

| Listener | Write -> handled |
|---|---|
| healthy | 51 ms |
| session killed | **7,695 ms** |

One run each. One error line is logged and nothing else. The apps use `backoffMaxSeconds: 120`, so by the same mechanism the bound is 120 s (**derived** from the config, not measured).

**D3b, does a new listener ever open?** Counting `LISTEN crablet_events` sessions: 1 before the kill, **0 at +5, +10, +15, +20, +25 and +30 s**. Nothing re-establishes it (**measured**), and the code explains why: the dispatcher loop catches the stream's failure, logs it, and ends. Scope: each module (views, outbox, automations) has its own processor and its own listener, so killing one session affects that module's processors; a database restart would lose all of them.

### D4 - does a reserved connection survive its session being killed?
The question behind step 1's heartbeat. A connection reserved from the pool takes an advisory lock, then its backend is terminated: three queries on the same connection afterwards **all fail**, and the lock has no holder (**measured**).

**Correction (2026-10-06): the conclusion first drawn from this was wrong.** It said a successful query on the leader's connection proves the lock is held, because "there is no silent reconnect". D4 only showed that the queries right after the kill fail. When the heartbeat was built as `SELECT 1` and D1 was re-run, the old leader still handled events: a temporary log showed the heartbeat failing once and then **succeeding again**, because the pooled connection came back on a NEW session that answers queries but does not hold the lock. So an answered query proves nothing. The shipped check asks Postgres whether THIS session holds the advisory lock (`pg_locks`, `pid = pg_backend_pid()`), and D1 then went to zero. The lesson, kept because it applies to the rest of this plan: test the property you need (holds the lock), not a proxy for it (answers a query).

### E5 - command latency against the events in its boundary (strict command, model folds every event)
| Events in the boundary | command p50 | command p95 | unconditional append, same tag |
|---|---|---|---|
| 0 | 2.8 ms | 8.7 ms | 0.9 ms |
| 1,000 | 6.1 ms | 10.3 ms | 0.6 ms |
| 10,000 | 19.5 ms | 31.1 ms | 0.8 ms |
| 100,000 | **190 ms** | 207 ms | 0.8 ms |
| 500,000 | **1,119 ms** | 1,242 ms | 1.1 ms |

Roughly linear, about 2 microseconds per event (**measured**). The events are tiny (about 40 bytes of JSON) and were inserted in bulk, so real payloads will cost more to load. The unconditional append is constant, but it has no condition, so it does not show whether the strict command's conflict check also grows with the boundary: **where the time goes (fetching the rows, decoding them, folding them, or the append's conflict check) was measured next, in E5b below.**

### E5b - where the time of a command goes (100,000 events in the boundary; p50 of 15 runs, one run of the script)
| Part | Time | Share |
|---|---|---|
| Command, whole | 186 ms | 100 % |
| Load the state (fetch, driver, row objects, decode, fold) | 180 ms | 97 % |
| of which the database executing the read (EXPLAIN ANALYZE: index scan, 100,000 rows) | 44 ms | 24 % |
| of which driver, network and building 100,000 row objects (fetch-and-parse-only minus database time) | ~109 ms | ~58 % |
| of which schema decode and fold of the payloads | ~26 ms (decode alone, over the same payloads in a loop: 12 ms) | ~14 % |
| Append with its conflict check, and the rest of the command | ~6 ms | ~3 % |

**Measured**, with the split computed by subtraction (the parts were timed as separate runs, so they are approximate to a few ms). Three things follow. (1) The conflict check does not grow with the boundary: the append plus the rest is 6 ms at 100,000 events, because it only looks past the position the command loaded (**measured**). (2) The cost is moving rows: about 1.1 ms of the 1.8 ms per 1,000 events is the driver and object building, more than the database and the CPU work together (**derived** from the table). Making the decode or the fold faster cannot help much; fewer rows must be read. (3) The events are tiny (about 40 bytes of JSON) and the row has 8 columns, including `tags`, `occurred_at` and two ids that a fold rarely uses: with real payloads the share of transfer grows (**inference**, not measured). Not measured: the cost of reading fewer columns. (A snapshot did not exist when this was written; its effect is E5e.)

### E5c - reading only the events after a cursor (what a snapshot leaves to read)
In a boundary of 100,000 events, reading the last 10 through the command's read path: **0.5 ms** (p50) when nothing newer is in the log, **16 ms** (database 14.7 ms) when 400,000 events of other entities were written after it (**measured**, one run, 15 reads each). In the second case the planner reads the whole entity through the GIN tags index and filters by cursor afterwards, so the tail read is still linear in the entity's size, about a tenth of the full read (**derived**: 16 ms against 180 ms). The events were bulk-inserted in one transaction, so every row has the same transaction id and the cursor effectively compares positions only; a log with many transactions was not measured.

### E5d - a transfer (`all`, two accounts) when one has 100,000 events
Before the horizon change: p50 **403 ms**, p95 572 ms; after: p50 **218 ms**, p95 281 ms (**measured**, one run each, 15 transfers; the same script before and after). The saving is the union read that `all` did only to learn a position (ADR-0018, decision 8).

### E5e - the same command with a snapshot on its model (ADR-0018, fully wired)
p50 of 25 commands, one run: at 100,000 events 185 ms without a snapshot, 2.9 ms with one once taken, **19.1 ms** after 200,000 events of other entities were written following the snapshot; at 500,000 events 1,094 ms, 3.0 ms, **26.2 ms**. The first command (full fold plus the write) costs about the same as without a snapshot (193 and 941 ms). **Measured**; payloads were about 40 bytes and the bulk-inserted events share few transaction ids. The last figure is the realistic one: the tail read still walks the other entities' newer events through the tags index (E5c), so it grows with the log written after the snapshot, not with the entity's size.

### E7 - an event whose stored payload no longer matches its schema is in a command's boundary
The command **fails with a defect** (a schema decode error, not a typed failure) and **fails again on every later attempt** (**measured**): one old-shape event makes the entity unusable until its data is fixed. Over HTTP that would be the generic 500 problem (**from the code**: the handler turns an unhandled defect into it; not run over HTTP).

### E8 - cost of an event on disk (50,000 real appends, tag rows and indexes included)
**476 bytes per event** (measured twice): 182 heap + 119 indexes + 175 for `crablet_event_tags` (37 %), for a payload of about 70 bytes of JSON, so real events cost more in the heap. 100 million events is about 48 GB; a billion about 476 GB (**derived**, assuming that payload size). Append rate on one connection in batches of 100: 18,000 to 22,000 events/s. No partitioning, retention or archival exists (**from the code and the migrations**).

## Diagnosis (ranked by severity and evidence)

**F1. A leader that lost its lock keeps working, and nothing fences it. High. Measured: the zombie and the duplicates (D1) and the unguarded write (D2); a backwards cursor in the wild was not observed.**
Cause (code): `LeaderHandle.isLeader()` is `!closed`, and `closed` is set only by `release()`; nothing watches the reserved connection; the processor checks `isLeader()` only at the top of a tick; `updateCursor` is an unconditional `UPDATE`. Effect: after a connection loss two leaders run, a third of events are handled twice (measured), and the cursor can go backwards (by construction, D2). By module (from the code and the design, not each measured): views are required to be idempotent (at-least-once, ADR-0012), so it is wasted work; the outbox publishes to external systems at-least-once (duplicates leave the building); automations issue follow-up commands (duplicate commands, safe only if each command is idempotent - not verified here). No metric showed it: the leadership gauge is set only when the retry loop sees a change, so it stayed at 1 on the zombie (**from the code**, not observed). Since the fix `isLeader()` turns false on loss, so the retry loop sets the gauge to 0 at its next pass (**from the code**; not observed in an experiment).

**F2. Failover takes up to 30 s, 15 s on average. High for availability. Measured at a 5 s interval (D1b), derived for 30 s.**
Cause (as diagnosed): followers retried `pg_try_advisory_lock` every `leaderElectionRetryIntervalMs` (30 s everywhere); nothing woke them when the lock was released. Since step 3 the default is 5 s and a graceful release wakes them. F1 hides F2 when only the connection dies, and F2 is the whole story when the process dies.

**F3. The poller's wake-up listener never recovers. Medium-High for freshness. Measured (D3, D3b).**
A lost listener silently turns every processor of that module into timed polling, with a write-to-view lag of 7.7 s in the experiment and up to 120 s in the apps' configuration (derived); a database restart loses the listeners of all modules at once. The view progress hub (ADR-0016) already solves this for its own channel; the poller's channel does not use it.

**F4. Command latency grows linearly with the boundary; there are no snapshots. High at scale. The growth is measured (E5) and attributed (E5b): loading the boundary is 97 % of the command. Addressed by ADR-0018 (snapshots, opt-in per model): 185 to 19 ms at 100,000 events and 1,094 to 26 ms at 500,000 in the realistic case (E5e).**
A hot entity at one event per second reaches 100,000 events in about 28 hours (derived) and then costs 190 ms per command (measured); a strict command's per-entity throughput is then roughly the inverse, about 5/s (inference: strict commands on one boundary conflict and retry, not measured). Not a correctness problem; a cliff for long-lived entities.

**F5. One event in an old payload shape bricks its boundary, with a defect. Medium, measured (E7).**
There is no tolerant reading, no typed error naming the bad event, and no check that stored events still decode.

**F6. 476 bytes per event and no retention story. Medium-Low today, measured (E8).**
Fine for tens of millions of events; the tag table is over a third of the cost; nothing plans for a billion.

**Known and unchanged by this work (no new data):** the poller reads only below the oldest open transaction (a stall is visible to readers, ADR-0015); writers on one hot `(type, tag)` serialize (ADR-0003 measured it). The p99 of `latest` reads under writes is inconclusive (ADR-0016).

## What I did not measure
An OS-level crash of a leader process (emulated by terminating the session and stopping the fibers), a network partition or half-open TCP connection to the database, a connection pooler in transaction mode, duplicate effects of the outbox and automations directly (only a view-style processor was measured; the fence and the forward-only cursor are shared code, the outbox's own tracker has no test of its own), anything on more than one machine, whether the outbox and automations modules show the same listener lag as the views module (same engine, so expected, from the code), and the cost of the heartbeat (one `pg_locks` lookup per second per leader, not timed). For snapshots: payloads larger than about 40 bytes, a log of many small transactions (the bulk-inserted events share few transaction ids), and many entities snapshotting at once.

## Results of the fixes
Each row is the same experiment re-run after the step (one run unless said; the diagnostics are re-runnable). Commits: step 1 `d59ceaf`, step 2 `8e2644b`, step 3 `d8c83d7`, step 4 `6f355c5`, `1b09360`, `d317e64`, `6022672`, `2bcdc46`, `5a25373`, `a8cbb20`, `e945a55`, `31b683c`, `dcea1d9` (ADR-0018 accepted in `8fb121d`).

| Experiment | Before | After |
|---|---|---|
| D1: old leader's handler calls after its session is killed (40 s) | 723 | **0** |
| D1: events handled by both instances after the kill | 232 of 728 | **0** |
| D2: cursor after writing 900 then 100 | 100 (regressed) | **900** (held) |
| D3: write to handled after 25 s idle, listener session killed | 7,695 ms | **78 ms** (healthy 44 ms) |
| D3b: `LISTEN crablet_events` sessions 5-30 s after the kill | 0 | **1** |
| D1b: takeover after a crash (six phases of the retry cycle) | at the old 30 s default: uniform in 0-30 s, mean about 15 s (**derived**; measured only at 5 s: 4.2, 3.4, 2.5, 1.8, 0.9, 0.2 s) | the default is now 5 s: 4.2, 3.4, 2.6, 1.8, 1.0, 0.2 s, mean 2.2 s (**measured**; a crash cannot announce itself, so the timer bounds it) |
| D1c (new): takeover after a graceful stop | up to the retry interval | **0.04 to 0.10 s** (mean 0.07 s) |
| E5: command at 100,000 / 500,000 events, model without a snapshot | 190 / 1,119 ms | 185 / 1,094 ms (the control column of E5e, after the horizon's extra statement per `project`: no measurable change) |
| E5d: transfer (`all`) from a 100,000-event account | 403 ms | **218 ms** |
| E5e: command with a snapshot, 100,000 / 500,000 events, other entities' events written after the snapshot | 185 / 1,094 ms | **19.1 / 26.2 ms** (2.9 / 3.0 ms when nothing is written after it) |

What each step shipped, in the order built:
1. **Truthful leadership, fence, forward-only cursor.** A heartbeat on the leader's reserved connection that checks the session still holds the lock (not `SELECT 1`, see D4), `verify` on the handle, the processor checking it before the handler and before the cursor moves (no handler error recorded), the retry loop releasing a lost handle, and `updateCursor` in both trackers guarded by `(last_transaction_id, last_position) < new` (no ping when it does not advance).
2. **A wake-up listener that reconnects.** `wakeupStream` never ends; backoff 500 ms to 30 s; one wildcard wake-up after each RE-connect; the dispatcher drains again if a stream ends anyway.
3. **Faster failover.** Retry default 5 s (processor config, the processor's fallback, both example apps); a graceful release unlocks and sends a wildcard `pg_notify` on `crablet_events` in one statement, and a wildcard wake-up ends a follower's retry sleep.
4. **Snapshots (ADR-0018, Accepted).** Profile (E5b), tail read (E5c), the cursor of `all` from read horizons (decision 8; proved on real Postgres, an executor-level test of the dangerous interleaving, mutation-checked), migrations V9 and V10, `SnapshotStore`, opt-in `.snapshot(...)` with a load of snapshot + tail that fails open, the executor writing after the transaction (the spike showed a write from inside it deadlocks a small pool), the differential helper and `verifySnapshots`.

## Plan
Ordered by severity and by how cheap the fix is against the evidence. Each step ends green (`bun run typecheck`, `bun run test:unit`, the integration suites in batches), is committed on its own, and is checked by re-running its experiment. Estimates are mine.

| | Step | Fixes | Evidence it worked | Cost | Depends on | Status |
|---|---|---|---|---|---|---|
| 1 | **Leadership that tells the truth, a fence, and a cursor that only moves forward** | F1 | D1 re-run: the old leader stops within about 2 s of the kill; events handled by both instances after that window: 0; D2: writing 100 after 900 leaves 900 | 1.5 days | - | **Done** (`d59ceaf`): 0 handler calls after the kill, 0 doubly handled, D2 holds 900. Residual: the outbox tracker's forward-only SQL has no test of its own |
| 2 | **A wake-up listener that reconnects** (the hub's pattern, on `crablet_events`) | F3 | D3 re-run: killed-listener lag within about 2 s, not 7.7 s; a reconnect counter | 1 day | - | **Done** (`8e2644b`): 78 ms, a session stays open. The "reconnect counter" was **not built**: a reconnect leaves no metric and no log line, only the wildcard wake-up it emits (the dispatcher logs if a stream ends or fails) |
| 3 | **Faster failover** | F2 | D1b re-run with the default configuration: mean at most about 2.5 s, worst at most 5 s | 0.5 day | 1 | **Done** (`d8c83d7`): mean 2.2 s, worst 4.2 s after a crash; 0.07 s after a graceful stop. The 5 s default is **not yet explicitly approved** (see Decisions) |
| 4 | **Where the boundary time goes, then a design for snapshots** | F4 | profile at 100,000 events (fetch, decode, fold); then an ADR; then E5 at 100,000 against a target set by the design (ADR-0018 fixed it at p50 at most 25 ms; the first guess here was 20 ms, about a tenth of today) with a differential test (snapshot against full fold) over random histories | 0.5 day to profile, 0.5 to design, about 3 to build | profile first | **Done** (ADR-0018 Accepted): 19.1 ms at 100,000 events in the realistic case, which meets 25 and, narrowly, 20. Open follow-ups: an index so the tail read does not walk other entities' newer events, tuning `every` (1,000 is a guess), where `version` is declared for generated models, a tutorial/README note, larger payloads |
| 5 | **Event schema evolution policy: a tolerant reader, not upcasters** (decided in [ADR-0017](../adr/0017-event-evolution-by-compatibility.md), proposed) | F5 | E7 passes: the old-shape event decodes with defaults; an undecodable event gives a typed error naming its position and type; a check that decodes every stored event type; a DCB check that finds event types under a model's tags that the model does not handle | 1.5 days (made before the open question below, so unreliable) | an ADR | **Not started.** ADR-0017 is Proposed; first a spike on how to write a decoding default in Effect Schema 4.0.0 (two attempts failed on guessed APIs), and the policy is revised if it cannot be done cleanly |
| 6 | **Storage visibility, then a retention decision** | F6 | table-size metrics; a decision (partitioning, whether the tag table is needed) before 100 million events | 0.5 day | - | **Not started.** Add the snapshot table (bounded by entities, not events) to the size metrics |

### Step 1, the design as built (item 1 corrected, see D4)
1. **Truthful leadership.** The leader's reserved connection is monitored (a heartbeat query on it every second, with a timeout and two consecutive failures before it counts as lost). A session lock exists only while its session does. **As first written this said a successful query on the connection proves the lock is held; that was wrong (D4, correction):** the pooled connection can come back on a new session that answers queries without the lock. What the heartbeat and `verify` run is a check that THIS session holds the advisory lock (`pg_locks`). `isLeader()` becomes false on loss and the scope is closed, so the retry loop can try again. A `verify` effect on the handle exposes the same check. D4 measured that the queries right after a kill fail; it did not establish that none succeed later. The tests of step 1 kill the leader's session and assert that `verify` turns false and `isLeader()` follows within the heartbeat window (`leader-liveness.test.ts`, mutation-checked).
2. **A fence in the processor.** Before it hands a batch to the handler, and again before it moves the cursor, a processor verifies it still leads and, if not, stops that tick without recording a handler error. This bounds a zombie's duplicate work to one batch.
3. **A cursor that only moves forward.** `updateCursor` (views and automations, and the outbox's own tracker) becomes `... WHERE (last_transaction_id, last_position) < new`, so a stale write changes nothing, sends no ping, and cannot regress the cursor even in the microsecond window a check cannot close. A deliberate rewind by SQL still works (that is how ADR-0012 recovers a view); the tracker's `reset` does not rewind the cursor today, so nothing in the code relies on writing it backwards.
Residual of the fence: it bounds a zombie's duplicate work to one batch, it does not remove it: a leader that passed the check just before losing the lock can still publish that one batch (outbox) or issue its follow-up commands (automations). Risks: a false "lost" under load (mitigated by the timeout and two failures; the cost is a harmless step-down and re-acquire); the heartbeat shares the reserved connection with `verify` (serialized by the connection); a pooler in transaction mode breaks session locks and is already unsupported.

### Decisions
Resolved:
1. ~~**Order.**~~ Done as 1, 2, 3, then profile and snapshots (4). Reasoning kept: F4 is the one that grows with success, F1-F3 fail at incidents.
2. ~~**ADR for step 5 before code.**~~ ADR-0017 was written and is **Proposed** (it stays so until the spike below).
3. **ADR-0018 (snapshots): Accepted** (2026-10-06), with the follow-ups listed in the step 4 row.
4. **Integration tests run with `--test-concurrency=4`**: with the default, full runs on this machine failed on 60 s test-database startup timeouts; not measured on CI.

Still open:
5. **The 5 s leader retry and wake-on-graceful-release (step 3).** I built both on my own recommendation and they are committed; they are a behaviour change (about one extra `pg_try_advisory_lock` per module per instance per 5 s, and a wildcard `crablet_events` notification on a graceful stop). A worst-case 5 s stall after a crash remains. Approve, or say what to change.
6. **Step 5's rule (kept from the original item 3):** from the talk (David Schmitz, "Event Sourcing - You are doing it wrong"; the rule as pasted by the project owner, which agrees with slides 94-108 of his deck: upcaster chains shown as unmaintainable, "Weak schema to the rescue", "Prefer simple, text-based, human readable events"): **a new version of an event must be constructible from the old one.** A new field needs a sensible default and the event stays the same event; otherwise it is a **new event with a different name**. Traditional versioning, double-writes and upcasters were dropped as unmaintainable. Applied here: a tolerant reader (optional fields with defaults, never rename or remove), a typed error naming the bad event, a new event type for a breaking change, and no version column or upcasters; checked with fixtures of each type's old payloads and a `verify-events` script. DCB adds two rules: a model that stops handling an old type silently drops it from its boundary and its conflict check, so a check must find event types under a model's tags that the model does not handle; and tags are additive-only because they define the boundary. (An earlier draft proposed upcasters; that was a misreading of a summary of the talk, corrected.) The open question is mechanical, not a policy: how to write an optional key with a decoding default in the pinned Effect Schema 4.0.0.
