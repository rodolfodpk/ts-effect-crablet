# ADR-0019: Storage is visible, and the tag table is heavier than its reads need

## Status

Accepted (2026-10-07). The visibility part and the slim tag-key table (**migration V11**) are built and tested. Retention is deliberately not decided. **The recommendation changed twice while it was checked, and the history is part of the record**: the first measurement (hand-written approximations of the poller's SQL) said "drop the table"; the check with the poller's real query builders said the opposite for rare keys; a third measurement found the middle path that was built. Shipped numbers are in "What shipped" and differ from the forecast in one respect (the disk saving is smaller; see there).

## Context

Plan step 6 (docs/plans/reliability-and-scale-diagnostic.md, F6) asked for storage visibility and a retention decision before the log reaches 100 million events. The earlier measurement (E8: 476 bytes per event, 37 % of it the tag table) used events with one tag and a small payload. Measured again with events shaped like the wallet's (95 % deposits with 5 tags, 5 % transfers with 7 tags, payloads of about 170 bytes of JSON), 1,000,000 events through the real append path (`packages/eventstore/diagnostics/storage.diagnostic.ts`, E9; one laptop, one run, p50 of 15 for timings):

**Where the bytes go (E9a), 1,000,000 events**

| | Size | Per event |
|---|---|---|
| `crablet_events` heap | 376 MiB | 394 B |
| its indexes: GIN on `tags` 119 MiB, `(type, position)` 69 MiB, `(transaction_id, position)` 30 MiB, primary key 21 MiB | 239 MiB | 250 B |
| **events table total** | **615 MiB** | **644 B** |
| `crablet_event_tags` heap (5.1 million rows, 197 B per row) | 280 MiB | 293 B |
| its indexes: primary key `(key, value, position)` 320 MiB, `(key, position)` 301 MiB, `(position)` 57 MiB | 678 MiB | 711 B |
| **tag table total** | **958 MiB** | **1,004 B** |
| **both** | **1,573 MiB** | **1,649 B** |

The tag table is **61 %** of the space, and its three indexes are more than two thirds of it. At 100 million events of this shape the log would take about 165 GB (**derived**), of which the tag table is about 100 GB; at a billion, about 1.65 TB.

**Why it exists, in the schema's own words** (V1): "derived data maintained atomically on append ... to give legacy per-processor poller SQL an indexed key/value lookup shape instead of scanning `unnest(crablet_events.tags)` per candidate row." That is the claim the measurements below test.

**Who reads the tag table.** From the code: only the pollers' key-presence selections (`requiredTags`, `anyOfTags` in `packages/event-poller/src/internal/sql.ts`: "events that carry a tag with this KEY") and the change-impact report's `eventFactsFromLog`. The append path, the conflict check and the model queries use `crablet_events.tags` with its GIN index, not the tag table. Nothing reads the `value` column.

**What it costs on the write path (E9c).** 60,000 deposits through the real append function, with and without the tag-row inserts (the function altered in a scratch database): **4,832 events/s with them, 18,718 without**: the tag rows cost 74 % of append throughput here (one connection, batches of 200, indicative).

**What it buys on the read path: the corrected measurement (E9d, E9f).** The first version of this section used hand-written SQL imitating the poller's and a one-key filter, and concluded that "the tag table is never meaningfully faster than scanning the events' own tags". **That was wrong.** With the poller's real query builders (`buildEventSelectionQuery`, `buildPendingSelectionQuery`) and the wallet's real selections, 1,000,000 events, p50 of a batch of 100 (the shapes agreed across two full runs; the numbers below are the second run):

| Selection | Tag table | Scan the events' own tags | Slim table `(key, position)` |
|---|---|---|---|
| a wallet view (5 types + the 3 wallet keys), tail / catch-up | 1.9 / 1.0 ms | 2.2 / 0.9 | 2.0 / (same plan) |
| the outbox topic (3 wallet keys), tail / catch-up | 1.2 / 1.0 | 1.1 / 1.6 | |
| **rare key (0.01 %), tail** | 0.7 | 8.1 | 0.6 |
| **rare key, catch-up from the start** | **0.7 ms** | **2,539 ms** | **0.6 ms** |
| required `transfer_id` on transfers, catch-up | 7.3 | 1.3 | 9.7 |
| **pending check, rare key, last 5,000 events** | 5.8 | 162 | 5.9 |
| pending check, key that never occurs, last 100,000 | 119 | 246 | 126 |
| **size** | 958 MiB | 0 | **420 MiB (44 %)** |
| **append throughput** (60,000 deposits, one connection) | 4,186 events/s | (no rows) 18,718 | **9,664 (2.3 times)** |

So: for the wallet's own selections (common keys) the tag table buys nothing; for a **rare key** it is the difference between 0.7 ms and 2.5 seconds on a catch-up (and the scan grows with the log: about 25 seconds at 10 million events, derived), and between 6 ms and 160 ms on the "anything pending" check behind consistent reads. A slim table with just `(key, position)` and its primary key gives the same reads as the full one at 44 % of the space and 2.3 times the append throughput. (A `tag_keys` array column with a GIN index was also tried in the first round: best for rare keys, but worse for a selective tail; not pursued.)

**Under concurrency (E9e): five pollers (four views and an outbox topic, the wallet's selections) and a writer at once, 20 s each, 1,000,000 events already in the log:**

| | Writer | Poller fetch p50 / p95 / p99 |
|---|---|---|
| as built | 2,463 events/s | 2.9 / 36.7 / 405 ms |
| no tag table, scan, no tag rows | 7,598 | 1.6 / 8.4 / 352 |
| **slim table, written, pollers use it** | **5,368 (2.2 times)** | **2.4 / 9.7 / 377** |

The p99 of 350 to 400 ms appears in all three (a periodic stall, checkpoint or vacuum, not examined); the slim table is better than as-built on every other figure. One run each, a laptop.


## Decision (visibility, built)

1. `storageReport({ exact? })` (`@crablet/eventstore/Storage`): for every `crablet_*` table, the estimated rows and the bytes split into total, heap, indexes and TOAST, read from the catalog (no table scan), largest first, plus events and bytes per event. `formatStorageReport` prints it; `examples/wallet-example-app/scripts/report-storage.ts` runs it (`--exact` also counts the events table).
2. Gauges `crablet.storage.table_bytes` (by table and part), `crablet.storage.table_rows` and `crablet.storage.bytes_per_event`, kept current by `monitorStorage({ every })`, a fiber the application forks (default every 5 minutes; a failed read is logged and retried).

## Decision (the tag table): slim it, built as migration V11

Approved by you on 2026-10-07 and built:
- a new table `crablet_event_tag_keys (key, position)` with primary key `(key, position)` and nothing else: no `value` column, no other index, no foreign key. Nothing read `value`; the primary key answers the pollers' `EXISTS` lookups; the table is derived data;
- **one row per distinct key of an event**: the insert is `DISTINCT`, because an event can carry the same key more than once (list-valued tags such as `product_id=p1, product_id=p2`) and a primary key on `(key, position)` would otherwise refuse the second row. (The measurements of the slim copy did not include this; a test would have failed without it: mutation-checked.)
- the backfill reads **`crablet_events.tags`, the source of truth**, not the old table, so it also repairs drift (the migration test found an event inserted raw, bypassing the append function, that the old table never had a row for);
- `append_events_batch` writes only the key rows; the pollers' two clauses and `eventFactsFromLog` read the new table; the old `crablet_event_tags` is dropped;
- the migration takes `LOCK TABLE crablet_events IN SHARE ROW EXCLUSIVE MODE` first, so no writer can append through the old function between the backfill and the function swap; **writers wait for the length of the backfill (a full scan of the events table): plan a window on a large log**; readers carry on.

Why not the alternatives: **dropping the table** (the first recommendation) would make a rare-key selection take seconds per catch-up batch at a million events, growing with the log (2.5 s then; the pending check on a rare key 162 ms against 6 ms); **keeping it as it was** paid for a column and two indexes nothing used; **indexing only the keys some selection uses** needs a registry and a backfill when a key is added, and was not pursued; **a `tag_keys` array column with GIN** was mixed (worse on a selective tail).

Consequences specific to having no foreign key: `TRUNCATE crablet_events ... CASCADE` no longer clears the key table, and deleting events leaves their key rows behind (harmless to the pollers, which join through `crablet_events`). **Anything that resets a log (a test, a development database) must truncate both tables**, because positions restart at 1 and would collide with the stale rows; the differential test, which does so, failed until it did (fixed). The change is irreversible for an existing database once the old table is dropped (the key rows are rebuildable from `crablet_events.tags`; the old rows are not needed).

## What shipped, measured on the shipped schema (E9a, E9c, E9d, E9e with `SCHEMA=current`; 1,000,000 events; one laptop)

| | Before (V10) | Shipped (V11) |
|---|---|---|
| Tag table | 958 MiB (1,004 B/event) | **532 MiB (558 B/event)**, -44 % |
| **The log, events + tags** | **1,649 B/event** | **1,203 B/event, -27 %** |
| Loading 1,000,000 events through the append path | 177 s (5,658 events/s) | **66 s (15,095 events/s), 2.7 times** |
| 60,000 deposits, tag rows written / not written | 4,832 / 18,718 events/s (rows cost 74 %) | 13,012 / 22,143 (rows cost 41 %) |
| Five pollers + a writer: writer | 2,463 events/s | **7,470** (a no-key-rows variant: 8,510) |
| Five pollers + a writer: poller p50 / p95 / p99 | 2.9 / 36.7 / 405 ms | **2.2 / 7.0 / 266 ms** (variant: 1.6 / 5.1 / 354) |
| Rare key, catch-up from the start / pending check, last 5,000 | 0.7 ms / 5.8 ms | **0.6 ms / 6.7 ms** (scanning: 1,691 ms / 151 ms) |
| Wallet views and outbox (common keys), fetch | about 1 ms | about 1.2 to 1.7 ms (scanning: about the same) |

**A correction to my own forecast.** I forecast about 1,086 bytes per event (-34 %). The shipped schema is **1,203 (-27 %)**: the slim table I had measured was a compact copy built in one pass (`CREATE TABLE AS`, then the primary key), whereas the real table is filled by incremental inserts, whose B-tree is less dense (532 MiB, not 420). The write-side gain was larger than forecast (2.7 times on a load, not 2.3). At 100 million events of this shape: about 120 GB instead of 165 GB (derived).

Two weaker spots of the key table, both present before V11 and both seen in every run, recorded so they are not discovered later: the **pending check for a view that has matches shows a p95 of 170 to 370 ms** (p50 0.6 ms; scanning the events' own tags has no such tail) and a **selective combination (`MoneyTransferred` + a required key present on all of them) catch-up is 6.6 ms against 1.1 ms scanning**. Neither is new and neither was investigated.


## What was found, in the order it was found, and what remains

1. **E9b (first measurement, wrong conclusion).** Hand-written SQL, one key. Said: the tag table is never faster than scanning. Recommended dropping it. Written into this ADR as a recommendation.
2. **Asked "should we check the impact on the pollers?"** The real consumers filter on three keys at once and use a second query (the pending check) that had not been measured. I corrected the ADR to say so and then ran the check.
3. **The check (E9d with the real builders).** Reversed the conclusion for rare keys (above). Also built and kept:
   - the builders take `{ tagKeys: "table" | "scan" }` (default `"table"`, behaviour unchanged), so both forms run through the same code;
   - **an equivalence test** (`packages/event-poller/test/integration/tag-key-strategy-equivalence.test.ts`): 400 random selections (event types, required keys, any-of keys including ones that never occur, exact tags) and random cursors over 2,450 events written through the real append path, 50 of them in constructed transaction-id/position inversions; fetches and pending answers are identical between the two forms (mutation-checked: breaking the scan form fails it). The same test is a permanent guard that a derived key table agrees with the events' own tags.
   - the poller, outbox, automations, views, views-http and both example applications' integration suites (180 tests) were run with the scan form as the default: all passed except this very test, whose precondition (out-of-order positions) had depended on timing and was made deterministic.
4. **E9f / E9e (the slim table).** The middle path, above.

Since then the slim table was built (V11) and everything was run against it: the migration test (a populated V10 database upgraded to V11: the same pairs plus the one raw-insert repair, the old table gone, list-valued tags, the single-index shape, and the writer pause), the equivalence test (the key table against scanning), and the whole integration suite (342 tests). Still not done: the migration was not timed on a large existing table (the backfill is a full scan of the events table, with writers paused); the p99 stalls of 260 to 400 ms seen in every concurrent variant were not examined; behaviour over time (bloat, vacuum); and, as before, one machine and one event shape.


## Retention (not decided)

Nothing here deletes events: the log is the source of truth, and **retention is a modelling question before it is a storage one**. A command reads its model's boundary from the start of the entity's history unless the model is period-scoped (as the wallet's statements are) or has a snapshot (ADR-0018). Events below a point that no model reads any more could be moved to cheaper storage, for example by partitioning `crablet_events` by position range and detaching old partitions, but that is safe only once every reader (models, views rebuilds, the outbox, audits) has been shown not to need them, and the partitioning itself interacts with the foreign key from the tag table (gone if the table is dropped), the `(transaction_id, position)` cursor order and the GIN index. None of that was measured. Proposed: do not build partitioning now; revisit when a table approaches the point where the numbers above matter (about 100 million events, which is 65 GB without the tag table and 165 GB with it), or when a retention requirement exists, and begin with a "history horizon" rule (which models may read below which position) before any physical change.

## Consequences

- Operators can see where the bytes are and how fast they grow (the report and the gauges); the audit table and the other `crablet_*` tables are included.
- The log costs about 1,200 bytes per event for events of this shape (down from 1,650) and appends run about 2.7 times faster on a load; the pollers' reads are unchanged, rare keys included.
- Upgrading a database means a pause of writers for the length of a full scan of the events table; reads continue.
- Resetting a log means truncating `crablet_events` and `crablet_event_tag_keys` together.
- The equivalence test (the key table against the events' own tags) stays as a permanent guard that the derived table agrees with its source.
- The lesson recorded here applies to the rest of this work: a number measured with an approximation of the real query is not a measurement of the real query. The first conclusion was written down with confidence and was wrong; it was caught only because the real builders were run. And a number measured on a hand-built copy is not a measurement of the table the system will actually build.
