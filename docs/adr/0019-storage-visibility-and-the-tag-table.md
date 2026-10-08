# ADR-0019: Storage is visible, and the tag table costs more than it buys

## Status

Proposed. The visibility part is built (below). The tag table recommendation is **not** applied, and it is **not yet verified against the real pollers** (see "What has not been verified for the pollers"): it changes the schema and needs your decision after that check.

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

The tag table is **61 %** of the space, and three of its own indexes are two thirds of it. At 100 million events of this shape the log would take about 165 GB (**derived**), of which the tag table is about 100 GB; at a billion, about 1.65 TB.

**Why it exists, in the schema's own words** (V1): "derived data maintained atomically on append ... to give legacy per-processor poller SQL an indexed key/value lookup shape instead of scanning `unnest(crablet_events.tags)` per candidate row." That is the claim the measurements below test.

**Who reads the tag table.** From the code: only the pollers' key-presence selections (`requiredTags`, `anyOfTags` in `packages/event-poller/src/internal/sql.ts`: "events that carry a tag with this KEY") and the change-impact report's `eventFactsFromLog`. The append path, the conflict check and the model queries use `crablet_events.tags` with its GIN index, not the tag table. Nothing reads the `value` column.

**What it costs on the write path (E9c).** 60,000 deposits through the real append function, with and without the tag-row inserts (the function altered in a scratch database): **4,832 events/s with them, 18,718 without**: the tag rows cost 74 % of append throughput here (one connection, batches of 200, indicative).

**What it buys on the read path (E9b), 1,000,000 events, p50 of a batch of 100:**

| Selection | Tag table | Slim `(key, position)` | `tag_keys` column + GIN | No helper (split the tags of each row) |
|---|---|---|---|---|
| tail, key on every event | 1.2 ms | 1.4 | 1.2 | 1.0 |
| tail, key on 5 % | 3.0 | 3.8 | 7.9 | 2.5 |
| catch-up from the start, key on 5 % | 2.8 | 3.4 | 1.4 | 2.6 |
| tail, rare key (0.01 %) | 7.5 | 7.2 | 0.6 | 6.9 |
| catch-up from the start, rare key (0.01 %) | **3,064 ms** | 2,202 | 688 | 2,075 |
| space | 958 MiB | 421 MiB (44 %) | 93 MiB (10 %) | 0 |

In none of the five selections does the tag table beat scanning the events' own tags by a meaningful amount, and on the one that should favour an index, a rare key on a catch-up, it is the slowest (the poller's query is `ORDER BY transaction_id, position LIMIT n` with an `EXISTS`, so the planner walks the events in cursor order and probes the tag table per row; the key index is not what it uses). A `tag_keys` array column with a GIN index is much better for rare keys (0.6 ms, 688 ms) but worse for a selective tail (7.9 ms against 3.0) because the planner chooses a bitmap scan; it is not a free win.

## Decision (visibility, built)

1. `storageReport({ exact? })` (`@crablet/eventstore/Storage`): for every `crablet_*` table, the estimated rows and the bytes split into total, heap, indexes and TOAST, read from the catalog (no table scan), largest first, plus events and bytes per event. `formatStorageReport` prints it; `examples/wallet-example-app/scripts/report-storage.ts` runs it (`--exact` also counts the events table).
2. Gauges `crablet.storage.table_bytes` (by table and part), `crablet.storage.table_rows` and `crablet.storage.bytes_per_event`, kept current by `monitorStorage({ every })`, a fiber the application forks (default every 5 minutes; a failed read is logged and retried).

## Recommendation (the tag table, NOT applied: your decision, after the poller check)

**Stop writing the tag table and drop it**, in a new migration, once the poller check below has passed:
- remove the tag-row insert from `append_events_batch` (it is about 74 % of the write cost);
- rewrite the pollers' `requiredTags` and `anyOfTags` clauses to test the events' own tags (`EXISTS (SELECT 1 FROM unnest(e.tags) ...)`, as the "no helper" column), and `eventFactsFromLog` the same way (a maintenance read);
- `DROP TABLE crablet_event_tags`.

Result, on this data (the write and space figures are solid; the read figures are from approximations of the poller's SQL, see below): about 61 % less disk (644 instead of 1,649 bytes per event), about 3.9 times the append throughput, and the poller's selections within noise of today's (and faster on the rare-key catch-up).

Why this and not the alternatives:
- **Keep it as is**: pays 61 % of the space and 74 % of the write cost for no measured read benefit.
- **A slim `(key, position)` table**: saves 56 % of the tag table, still pays the per-row insert on every append and is not faster.
- **A `tag_keys` column with a GIN index**: 90 % cheaper than the tag table and the best for rare keys, but it changes the events table's shape, slows the selective tail in this test, and the gain is on a case (catch-up on a rare key) that can be addressed later if it ever matters.

Risks, stated: the drop is irreversible for existing databases (the rows are derivable from `crablet_events.tags`, one `INSERT ... SELECT` would rebuild it); anything outside this repository that reads `crablet_event_tags` breaks; the measurement is one run on one laptop with one event shape, a single connection and no concurrency, and a database with different statistics or a rare key on a much larger log could plan differently; the poller's selections on a key present in only a tiny fraction of a very long log were measured only at 0.01 % of 1,000,000 events.

## What has not been verified for the pollers

The read timings in E9b come from **hand-written SQL that imitates** the poller's fetch, not from the SQL the pollers actually build, and they cover less than the pollers do. Specifically:

1. **The real selections use several keys at once.** The wallet's four views and its outbox topic all filter with `anyOfTags` = `wallet_id`, `from_wallet_id`, `to_wallet_id` (`WalletViewConfig.ts`, `WalletApp.ts`). E9b measured one key (`= ANY` of a one-element array). An any-of-three test is a different plan and per-row cost.
2. **The "is anything still pending" query was not measured at all.** `buildPendingSelectionQuery` (`SELECT 1 ... LIMIT 1` over a `(after, upTo]` range, no `ORDER BY`) is what decides that a view has caught up, so it sits behind consistent reads (ADR-0015). Its plan and cost may differ from the fetch's.
3. **The SQL is not the real SQL.** E9b selected fewer columns and spelled the clauses by hand; the equivalence "the new query returns exactly the same events as the old" has not been tested.
4. **No concurrency.** Four views, the outbox and any automations poll at once in a real deployment, each with these queries, while commands append.
5. **Bloat, vacuum and statistics over time** were not examined.

To close this before any decision: generate the queries with the real `buildEventSelectionQuery` and `buildPendingSelectionQuery`, with the tag clauses swapped for the `unnest` form behind a switch; (a) a property test that old and new return the same rows for random selections (one key, several keys, none, combined with types and exact tags) over random data, including rows inserted out of order; (b) re-run E9b with the real builders and the wallet's three-key selection, and time the pending check; (c) run the poller, outbox, automation, views and views-http integration suites against the new form; (d) re-time under concurrent pollers and writers. If (a) or (c) fails, or (b)/(d) show a regression, the recommendation changes.

## Retention (not decided)

Nothing here deletes events: the log is the source of truth, and **retention is a modelling question before it is a storage one**. A command reads its model's boundary from the start of the entity's history unless the model is period-scoped (as the wallet's statements are) or has a snapshot (ADR-0018). Events below a point that no model reads any more could be moved to cheaper storage, for example by partitioning `crablet_events` by position range and detaching old partitions, but that is safe only once every reader (models, views rebuilds, the outbox, audits) has been shown not to need them, and the partitioning itself interacts with the foreign key from the tag table (gone if the table is dropped), the `(transaction_id, position)` cursor order and the GIN index. None of that was measured. Proposed: do not build partitioning now; revisit when a table approaches the point where the numbers above matter (about 100 million events, which is 65 GB without the tag table and 165 GB with it), or when a retention requirement exists, and begin with a "history horizon" rule (which models may read below which position) before any physical change.

## Consequences

- Operators can see where the bytes are and how fast they grow (the report and the gauges); the snapshot table and the audit table are included.
- If the recommendation is accepted: a migration (V11), a changed append function, three changed queries, a rebuild path documented, and a regression test that the poller's selections return the same events as before.
- If it is rejected: the cost per event stays 1,649 bytes for events of this shape, and the gauges make it visible.
