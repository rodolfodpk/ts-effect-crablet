// The code of docs/snapshots.md. Each `// #region name` ... `// #endregion name` is shown in the guide (a test keeps the two equal), and
// snapshots-guide.test.ts runs it.
import { Effect } from "effect";
import * as Schema from "effect/Schema";
import { SnapshotStore } from "@crablet/eventstore/SnapshotStore";
import type { AppendEvent } from "@crablet/eventstore/AppendEvent";
import { defineEvent } from "../../src/Event.ts";
import { defineModel } from "../../src/Model.ts";
import { checkSnapshotEquivalence } from "../../src/testing/Snapshots.ts";
import { verifySnapshots } from "../../src/VerifySnapshots.ts";

export const Opened = defineEvent("Opened", { schema: Schema.Struct({ walletId: Schema.String }), tags: (d) => ({ wallet_id: d.walletId }) });
export const Deposited = defineEvent("Deposited", {
  schema: Schema.Struct({ walletId: Schema.String, amount: Schema.Number }),
  tags: (d) => ({ wallet_id: d.walletId })
});
export const Withdrawn = defineEvent("Withdrawn", {
  schema: Schema.Struct({ walletId: Schema.String, amount: Schema.Number }),
  tags: (d) => ({ wallet_id: d.walletId })
});

// #region model
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
// #endregion model

// The same fold with a snapshot written after EVERY load (and one without any), for the equivalence check below.
export const BalanceEveryLoad = balanceFold().snapshot({ name: "wallet-balance", version: 1, schema: BalanceState, every: 1 });
export const BalancePlain = balanceFold();

// #region equivalence
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
// #endregion equivalence

// #region operate
// Against a copy of production data: does each stored snapshot still equal what folding the whole boundary gives? Read-only.
export const verifyStored = verifySnapshots({
  models: [{ name: "wallet-balance", instance: (entity) => Balance.of(entity as { id: string }) }],
  sample: 200
});

// After a version bump the old rows are never read again: remove them.
export const pruneOldVersions = Effect.flatMap(SnapshotStore, (store) => store.pruneOtherVersions("wallet-balance", 2));
// #endregion operate
