# Snapshots: keep a long-lived entity fast

A command decides by reading every event in its model's boundary and folding them into a state. For an entity with a long history that read is the cost of
every command: it grows with the history. A **snapshot** stores the folded state, and a command then reads the stored state plus only the events after it.
The decision and its reasoning are in [ADR-0018](./adr/0018-model-snapshots.md); every block of code below is real: it is
`packages/commands/test/support/snapshots-guide.ts`, and the tests run it.

## When it is worth it

Measured on one laptop with tiny events (about 40 bytes of JSON), one run each, a command that folds one entity's whole history:

| Events in the boundary | No snapshot | With a snapshot, realistic* | With a snapshot, nothing else written after it |
|---|---|---|---|
| 100,000 | 185 ms | 19 ms | 3 ms |
| 500,000 | 1,094 ms | 26 ms | 3 ms |

\* with 200,000 events of *other* entities written after the snapshot, which is what a busy log looks like. The first command after a long history still folds
everything once (and writes the snapshot), so it costs about what no snapshot costs.

**Do you need them?** Probably not, until you measure a problem. Without a snapshot a command costs about 2 microseconds per event of the entity's history, so
the history a model can carry is roughly its latency budget divided by that: 50,000 events for 100 ms, 250,000 for 500 ms. An entity that gains one event a second
reaches 100,000 in about 28 hours; most entities never get near such numbers. Often the better fix is modelling: scope the model by period (the wallet's statement
periods do) so its boundary stays small. Snapshots are for entities whose history grows without bound; they are **opt-in per model**, and no example application uses
them. Not measured: larger payloads, many small transactions, many entities snapshotting at once.

## Opting in

<!-- file: packages/commands/test/support/snapshots-guide.ts#model -->
```ts
// The state must describe itself with a schema and survive a round trip through JSON (no Map, Set, Date or bigint).
const BalanceState = Schema.Struct({ exists: Schema.Boolean, balance: Schema.Number });

const balanceFold = () =>
  defineModel({ by: "wallet_id", initial: () => ({ exists: false, balance: 0 }) })
    .lifecycle(Opened, () => ({ exists: true, balance: 0 }))
    .on(Deposited, (w, d) => ({ ...w, balance: w.balance + d.amount }))
    .on(Withdrawn, (w, d) => ({ ...w, balance: w.balance - d.amount }));

// Opt in: chain `.snapshot(...)` last. `version` is yours to bump when the FOLD changes; `every` (default 1,000) is how many events a load must have
// folded before a snapshot is written.
export const Balance = balanceFold().snapshot({ name: "wallet-balance", version: 1, schema: BalanceState });
```

Two things must be in place:

- **The tables.** Migrations V9 and V10 (`migrationFiles` in `@crablet/db-migrations` already lists them). A model that opts in on a database without them
  fails with the database's error: that is deliberate, not hidden.
- **The store.** `Crablet.layer(...)` provides `SnapshotStore`. If you assemble your own layers, add `SnapshotStoreLive`; without a store in the context a
  snapshotted model simply loads like an ordinary one.

## What happens

- A **load** reads the stored snapshot (if there is a usable one) and only the events after its cursor. A snapshot holds the state *at a settled cursor*, so
  nothing can later appear below it; the state of events that are committed but not settled yet is never stored.
- The snapshot is **written after the command's transaction has ended**, committed or not (the state is valid either way), with a timeout, and a failure
  to write is ignored. Writing from inside the transaction would need a second connection while holding the first, which deadlocks a small pool (measured).
- A snapshot is a **cache and fails open**: if it is missing, from another version, or its state no longer decodes, the load folds the whole boundary, as
  if there were none. (An error from the database itself is the exception: it is reported.)
- It is keyed by the snapshot `name`, the `version` and the model's boundary query (so: the entity). Changing which events the model handles changes the
  query, and so the key, by itself.
- A model over **several entities** (`all(...)`) has each member snapshot on its own; the combined cursor comes from the members' read horizons, which also
  means it no longer reads the whole union boundary just to learn a position.

## What you have to do

- **Bump `version` when the fold changes** what it does with events it already handled. The old rows are then never read again. A fold that changed
  without a bump gives wrong state silently, until the check below finds it. This is the one rule the framework cannot enforce for you.
- Keep the state **small and JSON-safe**. A snapshot copies whatever the state holds, personal data included; anything that erases personal data must
  erase or rewrite snapshots too.

## Testing it

Snapshot + tail must equal the full fold, for any history and any point where a snapshot was taken. The helper builds random histories, splits them at random
points, writes a snapshot after each load and compares with a reference that never reads one. Use a model with `every: 1` as the snapshotted side:

<!-- file: packages/commands/test/support/snapshots-guide.ts#equivalence -->
```ts
// Snapshot + tail must equal folding the whole boundary, for ANY history and ANY point where a snapshot was taken.
const history = (random: () => number): ReadonlyArray<AppendEvent> => {
  const events: Array<AppendEvent> = [Opened({ walletId: "w1" })];
  for (let i = 0; i < 1 + Math.floor(random() * 40); i++) {
    events.push(random() < 0.6 ? Deposited({ walletId: "w1", amount: 1 + Math.floor(random() * 9) }) : Withdrawn({ walletId: "w1", amount: 1 + Math.floor(random() * 5) }));
  }
  return events;
};

export const snapshotEquivalence = () =>
  checkSnapshotEquivalence({
    snapshotted: (id) => BalanceEveryLoad.of({ id }),
    reference: (id) => BalancePlain.of({ id }),
    id: "w1",
    history,
    runs: 200
  });
```

`InMemorySnapshotStore` (`@crablet/eventstore/testing/InMemorySnapshotStore`) is the same store without a database, for your own unit tests.

## Operating it

<!-- file: packages/commands/test/support/snapshots-guide.ts#operate -->
```ts
// Against a copy of production data: does each stored snapshot still equal what folding the whole boundary gives? Read-only.
export const verifyStored = verifySnapshots({
  models: [{ name: "wallet-balance", instance: (entity) => Balance.of(entity as { id: string }) }],
  sample: 200
});

// After a version bump the old rows are never read again: remove them.
export const pruneOldVersions = Effect.flatMap(SnapshotStore, (store) => store.pruneOtherVersions("wallet-balance", 2));
```

`verifySnapshots` rebuilds each sampled row's model from the entity stored with it, loads it once as a command would and once ignoring every snapshot, and
compares states and positions (it reloads before reporting a difference, because a command may append between the two loads). It reports `mismatch` (the
fold changed without a version bump, or it is not deterministic), `stale_boundary` (the model's query changed since the row was written),
`undecodable` and `unverifiable` (written before V10, no entity stored), and the stored name and version pairs that no registered model accounts for. It never
writes.

Metrics: `crablet.snapshot.loads` (by model and outcome: `hit`, `miss`, `invalid`, `unavailable`), `crablet.snapshot.folded_events` and
`crablet.snapshot.writes` (`written`, `not_newer`, `failed`). A model whose loads are all `miss` is not using its snapshots.

## Limits

- The read of the events *after* the snapshot still goes through the tags index, so it grows with the log written after the snapshot, not with the entity:
  the 19 ms above is that effect. An index that lets it seek is an open question.
- `every` defaults to 1,000 events, a guess to be tuned from your own numbers.
- No example application uses snapshots yet; the code above and `packages/commands/test/model-snapshot.test.ts` are the examples.
- For commands generated from contracts, where `version` is declared is not settled.
