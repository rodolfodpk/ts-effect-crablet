# ADR-0018: A model's state can be snapshotted at a settled cursor; a snapshot is a cache, never a fact

## Status

Proposed.

## Context

A command loads its model's state by reading every event in the model's boundary and folding it (`Model.ts`: `eventStore.project(query, zero, [projector])`). The cost grows with the boundary.

**Measured** (docs/plans/reliability-and-scale-diagnostic.md, E5, E5b, E5c; one run of each script, a laptop, Postgres in Docker, events of about 40 bytes of JSON):
- A command takes 2.8 ms with an empty boundary, 19.5 ms at 10,000 events, 190 ms at 100,000 and 1,119 ms at 500,000.
- At 100,000 events (186 ms): loading the state is 97 %. Inside it: the database's own execution of the read 44 ms, driver and building the row objects about 109 ms, schema decode and fold about 26 ms. The append with its conflict check and the rest is about 6 ms. The conflict check does not grow with the boundary (it looks only past the loaded position).
- So only reading fewer rows helps. Faster decode or fold cannot.
- Reading only the events after a cursor, 10 of 100,000 (E5c): 0.5 ms when the log holds nothing newer; **16 ms** (database 14.7 ms, plan: bitmap scan of the GIN tags index, then a sort) when 400,000 events of other entities were written after it. The planner then reads the whole entity through the tags index and filters by cursor afterwards, so this tail read is still linear in the entity's size, about a tenth of the full read.

Facts the design relies on (from the code):
- The cursor of a load only advances over **settled** events (their transaction had finished when read), so no event can later appear below it: `(transaction_id, position)` order is stable under the cursor (ADR-0012; `EventStore.project`).
- `project(query, after, projectors)` already reads only events after a cursor, and a projector carries its own `initialState`.
- A model's boundary query is derived from the events its fold handles and its binding tags (DCB, ADR-0010).

## Decision

1. **Opt-in, per model.** `defineModel(...)...snapshot({ name, version, schema, every })`. No snapshot unless asked. `schema` is an Effect Schema for the state (JSON-safe); `version` is a number the author bumps when the fold changes; `every` is how many folded events trigger writing a new one (default 1,000).
2. **The key identifies what the state is a state of.** A snapshot row is keyed by `(name, version, fingerprint)`, where the fingerprint is a hash of the model's boundary query, which contains the entity's tags. Changing which events a model handles changes the query and so invalidates its snapshots by itself. Changing what the fold does with the same events cannot be detected, which is why `version` is explicit.
3. **The row.** `crablet_model_snapshots(name, version, fingerprint, transaction_id xid8, position bigint, state jsonb, updated_at)`, primary key `(name, version, fingerprint)`. It holds the state and the settled cursor it was folded to (the `logPosition` of the load that produced it).
4. **Load = snapshot + tail.** Read the row; decode `state` with the schema; read the events after its cursor with `initialState` set to it; fold. The `logPosition` returned is the tail's (or the snapshot's cursor if there is no tail), so the append condition is the same as without a snapshot.
5. **A snapshot is a cache and fails open.** If the row is missing, its state does not decode, or its version differs, the load folds the full boundary, as today, and a metric counts it. This is the opposite of events, which fail closed (ADR-0017): an event is a fact, a snapshot is derived data that can be deleted at any time without losing anything.
6. **Written after the load, outside the command's transaction, best effort and forward-only.** When the tail folded at least `every` events, upsert the new state with `WHERE (transaction_id, position) < (new)`, so a slow writer never moves a snapshot back. A failure to write is logged and ignored. The state written is the state at the load's settled cursor, so it is valid whether or not the command's own append then commits or conflicts. How to write outside an ambient transaction is for the spike (below).
7. **It is checked.**
   - A differential test helper: for random event histories and random snapshot points, loading with snapshot + tail equals the full fold, for any model that declares a snapshot. Models declaring one run it in their own tests.
   - A `verify-snapshots` script (like `verify-events`, ADR-0017): for a sample of rows, fold the full boundary and compare; report mismatches. It is how a forgotten `version` bump is found.
8. **Multi-entity models (`all`) take their cursor from the read horizon, not from a union scan.** Today `all` reads the whole union boundary only to learn a position (`positionOnly` in `Model.ts`), which costs as much as loading every member without snapshots. Instead:
   - Each member loads on its own (snapshot + tail, in parallel) and also reports its **horizon**: the `xmin` of a snapshot taken by a statement run *before* its read (`SELECT pg_snapshot_xmin(pg_current_snapshot())`; xmin never decreases, so it is never above the read's own). A read sees every event whose transaction id is below its xmin, and may miss any at or above it.
   - The append condition's cursor is `(min of the members' horizons, 0)`: a cursor whose transaction id is below the xmin of every member's read, so every event any member missed sorts after it. Every event the members did see and that had settled sorts before it.
   - `ProjectionResult` and `Loaded` gain a `horizon` (additive). The union scan is deleted. Single models keep the last-settled-event cursor: it refuses the same events as the horizon (everything at or above xmin), so nothing changes for them.
   - Why not the obvious cursors, **proved on real Postgres** (`packages/eventstore/test/integration/union-boundary-cursor.test.ts`, 3 tests, deterministic interleavings): the **maximum** of the members' last settled events can sit above an event that an earlier member read missed (member B reads while another transaction with a lower xid is uncommitted, that transaction commits, member A then reads its own newer event): the append is accepted over a state that lacks the missed event, a **lost conflict**. The **minimum** of the members' last events sits below events that every member saw (A's newer event while B's is older), so the condition refuses on every retry: **not live**. The minimum horizon refuses the first and accepts the second, and with an unrelated older transaction open it refuses exactly what a single model's cursor refuses today (its events are above xmin, so unsettled), then accepts once that transaction ends.
   - The horizon cursor has position 0. The TypeScript read path treats `after.position > 0n` as "has a cursor" (`queryEvents`), so this cursor is for the append condition only; a snapshot's cursor stays the last settled event (or the read path is changed to test the transaction id).
9. **Snapshots are not events.** They are never read by views, automations or the outbox, never exposed over HTTP, and never appended.

## Alternatives considered

- **Do nothing; tell users to model shorter-lived entities.** Valid advice (new entity per period, "closing the books"), and the cheapest. It is a modelling guideline for the docs, not a substitute: some boundaries are long-lived by nature.
- **Read fewer or lighter columns** (the fold rarely uses `occurred_at`, `correlation_id`, `causation_id`). Might trim the 109 ms of driver and object building, but the cost stays linear; not measured, so not claimed. It can be done independently.
- **A cache in process memory.** Lost on restart, wrong across instances, needs the same cursor logic anyway.
- **Snapshot by a background processor** like a view. Adds a leader, a progress table and a lag, and the command would still need the tail read; a lazy write by the command that paid for the full fold is simpler and self-healing.
- **Write the snapshot inside the command's transaction.** Simpler to wire, but it holds a row lock to commit, contends between concurrent commands on the same entity, and the work is lost when the transaction rolls back.
- **Snapshots as events** (a `SnapshotTaken` event in the log). Breaks "events are facts", grows the log, and every reader would have to know it.

## Consequences

- **Expected effect (derived, not measured end to end):** at 100,000 events a command would cost about 6 ms (append and the rest) + one row read + the tail read (0.5 to 16 ms in E5c) = **roughly 7 to 25 ms instead of 186 ms**. The acceptance test is E5 at 100,000 and 500,000 events with the log carrying events of other entities, against a target of p50 at most 25 ms at 100,000.
- **The tail read stays linear** in the entity's size when the planner takes the tags index (E5c, 16 ms at 100,000, so about 80 ms at 500,000, derived). Making it constant needs an index that can seek by tag and cursor; the normalized `crablet_event_tags(key, value, position)` exists, but it is ordered by `position` and the cursor is `(transaction_id, position)`, so a position seek is not equivalent (the very inversion ADR-0012 handles). Open point 2.
- **A model author takes on a rule:** bump `version` when the fold changes. Forgetting it gives wrong state silently until `verify-snapshots` or the differential test catches it. That is the cost of not hashing functions.
- **More storage:** one row per entity per model, bounded by the number of entities, not events. Old versions are garbage to prune by a maintenance statement.
- **Personal data:** a snapshot copies whatever the state holds. The state schema should hold what the decision needs and no more; deleting or shredding personal data (a separate decision, ADR-0017) must delete or rewrite snapshots too.
- **Unchanged:** the append condition's meaning and its SQL (only the cursor an `all` model passes changes, decision 8), conflict semantics, views, automations, the event log and every event's shape.

## Open points for the implementation

1. **Multi-entity models (`all`): decision 8 is built** (independent of snapshots): `horizon` on `ProjectionResult`/`Loaded`, `all` takes the earliest member horizon and no longer reads the union. **Measured** (E5d, one run, 15 transfers): a transfer from an account with 100,000 events to an empty one went from p50 403 ms to **218 ms** (p95 572 to 281 ms); the rest is the one large member's load, which snapshots will address. Tests: the deterministic SQL proof, `project` returns the right horizon on real Postgres (an open transaction pins it), and a 48-transfer concurrent stress through the executor (no overspend, money conserved). **Limit of that evidence:** replacing the cursor by the unsafe maximum in the code did NOT make the stress fail (3 runs), because the hazard needs reads straddling an uncommitted lower-xid transaction; the safety rests on the deterministic proof, and the stress is a regression smoke test. That gap is closed by `packages/commands/test/integration/all-union-cursor-postgres.test.ts`, which forces the interleaving through the real executor (X is read while a lower-xid transaction holds an uncommitted spend of 80, that transaction commits, a newer event lands in Y's boundary, then Y is read): with the horizon the append is refused, the command reloads and the domain refuses the transfer (X ends at 20); with the unsafe maximum cursor the same test fails with X at -60 (mutation-checked).
2. **Seeking the tail.** Whether to add an index or a query shape so the tail does not walk the whole entity (see Consequences). Measure before building; it can be a separate decision.
3. **Writing outside the ambient transaction.** Effect's `sql.withTransaction` makes the connection ambient to forked fibers; the snapshot write needs its own connection (or to run after the commit). A short spike decides, and its result is recorded here.
4. **Default `every`.** 1,000 is a guess. At about 1.8 ms per 1,000 events (E5) a full fold of 1,000 costs about 2 ms, so the default writes when the tail has become noticeable; tune with E5 data.
5. **`version` for generated models** (HTTP-derived commands): where it is declared.

## Implementation order

(Plan step 4 in docs/plans/reliability-and-scale-diagnostic.md.) 1. The spike for point 3 and the table (migration V9). 2. Load with snapshot + tail and fail-open, behind the opt-in, with the differential test helper. 3. The write after load, with the forward-only upsert and a concurrency test (two commands, same entity). 4. E5 re-run at 100,000 and 500,000 with other entities' events in the log; record the numbers here. 5. `verify-snapshots`. 6. The horizon for `all` (decision 8): `horizon` on `ProjectionResult`/`Loaded`, members loaded in parallel, the union scan removed, then the randomized executor test; this part does not depend on snapshots and can be built first. 7. Point 2 as a separate decision. Each step ends green and is committed on its own.
