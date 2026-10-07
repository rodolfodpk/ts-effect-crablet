// Runs the code of docs/snapshots.md (packages/commands/test/support/snapshots-guide.ts), so the guide shows what works.
import { describe, expect, test } from "bun:test";
import { Effect, Layer } from "effect";
import { makeInMemoryEventStore } from "@crablet/eventstore/testing/InMemoryEventStore";
import { makeInMemorySnapshotStore } from "@crablet/eventstore/testing/InMemorySnapshotStore";
import { SnapshotCollectorLive, flushSnapshots } from "@crablet/eventstore/SnapshotStore";
import { Balance, Deposited, Opened, pruneOldVersions, snapshotEquivalence, verifyStored } from "./support/snapshots-guide.ts";

describe("the snapshots guide", () => {
  test("a snapshotted model loads the same state as the plain fold, and leaves a snapshot once a load has folded `every` events", async () => {
    const fake = makeInMemoryEventStore();
    const snapshots = makeInMemorySnapshotStore();
    fake.seed(Opened({ walletId: "w1" }), ...Array.from({ length: 1_200 }, () => Deposited({ walletId: "w1", amount: 1 })));
    const layer = Layer.merge(snapshots.layer, SnapshotCollectorLive);
    const loaded = await Effect.runPromise(Effect.provide(Effect.tap(Balance.of({ id: "w1" }).load(fake.service), () => flushSnapshots), layer));
    expect(loaded.state).toEqual({ exists: true, balance: 1_200 });
    expect(snapshots.rows.size).toBe(1); // 1,201 events folded: over the default of 1,000
  });

  test("the equivalence check passes for the guide's model", async () => {
    await snapshotEquivalence();
  });

  test("the operations are Effects that need a database: here they are only built; pruning removes other versions", async () => {
    expect(typeof verifyStored.pipe).toBe("function");
    const snapshots = makeInMemorySnapshotStore();
    for (const version of [1, 2, 3]) await Effect.runPromise(snapshots.service.save({ name: "wallet-balance", version, canonical: "q", cursor: { position: 1n, occurredAt: null, transactionId: "1" }, state: {} }));
    expect(await Effect.runPromise(Effect.provide(pruneOldVersions, snapshots.layer))).toBe(2);
  });
});
