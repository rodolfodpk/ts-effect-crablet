import { describe, expect, test } from "bun:test";
import { Effect, Layer } from "effect";
import * as Schema from "effect/Schema";
import { makeInMemoryEventStore } from "@crablet/eventstore/testing/InMemoryEventStore";
import { makeInMemorySnapshotStore } from "@crablet/eventstore/testing/InMemorySnapshotStore";
import { SnapshotCollectorLive, canonicalQuery, flushSnapshots } from "@crablet/eventstore/SnapshotStore";
import { defineEvent } from "../src/Event.ts";
import { all, defineModel } from "../src/Model.ts";
import { checkSnapshotEquivalence } from "../src/testing/Snapshots.ts";

const Opened = defineEvent("Opened", { schema: Schema.Struct({ accountId: Schema.String, initial: Schema.Number }), tags: (d) => ({ account_id: d.accountId }) });
const Deposited = defineEvent("Deposited", { schema: Schema.Struct({ accountId: Schema.String, amount: Schema.Number }), tags: (d) => ({ account_id: d.accountId }) });
const Withdrawn = defineEvent("Withdrawn", { schema: Schema.Struct({ accountId: Schema.String, amount: Schema.Number }), tags: (d) => ({ account_id: d.accountId }) });

const State = Schema.Struct({ open: Schema.Boolean, balance: Schema.Number, events: Schema.Number });
const base = () =>
  defineModel({ by: "account_id", initial: () => ({ open: false, balance: 0, events: 0 }) })
    .on(Opened, (a, d) => ({ open: true, balance: d.initial, events: a.events + 1 }))
    .on(Deposited, (a, d) => ({ ...a, balance: a.balance + d.amount, events: a.events + 1 }))
    .on(Withdrawn, (a, d) => ({ ...a, balance: a.balance - d.amount, events: a.events + 1 }));
const Plain = base();
const Snap = (every = 3, version = 1) => base().snapshot({ name: "account", version, schema: State, every });

const deposits = (n: number, id = "a") => Array.from({ length: n }, () => Deposited({ accountId: id, amount: 1 }));
const setup = () => {
  const fake = makeInMemoryEventStore();
  const snapshots = makeInMemorySnapshotStore();
  const layer = Layer.merge(snapshots.layer, SnapshotCollectorLive);
  const run = <A>(e: Effect.Effect<A, unknown, any>) => Effect.runPromise(Effect.provide(e, layer) as Effect.Effect<A>);
  // the executor's job: load inside the transaction, flush after it
  const loadAndFlush = <S>(model: { load: (es: never) => Effect.Effect<S, unknown> }) =>
    run(Effect.tap(model.load(fake.service as never), () => flushSnapshots));
  return { fake, snapshots, run, loadAndFlush };
};

describe("a model that declares a snapshot", () => {
  test("a model WITHOUT `.snapshot` never asks the store", async () => {
    const { fake, snapshots, loadAndFlush } = setup();
    fake.seed(Opened({ accountId: "a", initial: 0 }), ...deposits(10));
    const loaded = (await loadAndFlush(Plain.of({ id: "a" }))) as { state: { balance: number } };
    expect(loaded.state.balance).toBe(10);
    expect(snapshots.gets()).toBe(0);
    expect(snapshots.rows.size).toBe(0);
  });

  test("a load that folds at least `every` events leaves a snapshot at its settled cursor; fewer events leave none", async () => {
    const { fake, snapshots, loadAndFlush } = setup();
    fake.seed(Opened({ accountId: "a", initial: 0 }), ...deposits(1)); // 2 events, every = 3
    await loadAndFlush(Snap(3).of({ id: "a" }));
    expect(snapshots.rows.size).toBe(0);
    fake.seed(...deposits(1)); // 3 events
    await loadAndFlush(Snap(3).of({ id: "a" }));
    const [row] = [...snapshots.rows.values()];
    expect(row!.state).toEqual({ open: true, balance: 2, events: 3 });
    expect(row!.cursor.position).toBe(3n);
    expect(row!.name).toBe("account");
  });

  test("the next load reads only the events after the snapshot and gets the same state as the full fold", async () => {
    const { fake, snapshots, run, loadAndFlush } = setup();
    fake.seed(Opened({ accountId: "a", initial: 100 }), ...deposits(4));
    await loadAndFlush(Snap(3).of({ id: "a" }));
    fake.seed(Withdrawn({ accountId: "a", amount: 7 }), ...deposits(1));
    // spy on what the load asks the event store for
    const asked: Array<bigint> = [];
    const spying = { ...fake.service, project: (q: never, after: { position: bigint }, p: never) => (asked.push(after.position), fake.service.project(q, after as never, p)) };
    const withSnapshot = (await run(Snap(3).of({ id: "a" }).load(spying as never))) as { state: unknown; logPosition: { position: bigint } };
    const reference = (await run(Plain.of({ id: "a" }).load(fake.service))) as { state: unknown; logPosition: { position: bigint } };
    expect(asked).toEqual([5n]); // from the snapshot's cursor, not from the start
    expect(withSnapshot.state).toEqual(reference.state);
    expect(withSnapshot.logPosition.position).toBe(reference.logPosition.position);
    expect(snapshots.rows.size).toBe(1);
  });

  test("with no new events the logPosition is the snapshot's cursor, so the append condition is unchanged", async () => {
    const { fake, loadAndFlush } = setup();
    fake.seed(Opened({ accountId: "a", initial: 0 }), ...deposits(4));
    await loadAndFlush(Snap(3).of({ id: "a" }));
    const again = (await loadAndFlush(Snap(3).of({ id: "a" }))) as { logPosition: { position: bigint } };
    expect(again.logPosition.position).toBe(5n);
  });

  test("a snapshot of another entity, another version or another fold is not used (full fold)", async () => {
    const { fake, loadAndFlush, run } = setup();
    fake.seed(Opened({ accountId: "a", initial: 0 }), ...deposits(4), Opened({ accountId: "b", initial: 0 }), ...deposits(2, "b"));
    await loadAndFlush(Snap(3, 1).of({ id: "a" }));
    const asked: Array<bigint> = [];
    const spying = { ...fake.service, project: (q: never, after: { position: bigint }, p: never) => (asked.push(after.position), fake.service.project(q, after as never, p)) };
    await run(Snap(3, 1).of({ id: "b" }).load(spying as never)); // entity b: no row
    await run(Snap(3, 2).of({ id: "a" }).load(spying as never)); // version 2: no row
    expect(asked).toEqual([0n, 0n]);
  });

  test("a stored state that no longer decodes is ignored: the full fold is used", async () => {
    const { fake, snapshots, run } = setup();
    fake.seed(Opened({ accountId: "a", initial: 0 }), ...deposits(4));
    const model = Snap(3).of({ id: "a" });
    await Effect.runPromise(snapshots.service.save({ name: "account", version: 1, canonical: canonicalQuery(model.query), cursor: { position: 3n, occurredAt: null, transactionId: "3" }, state: { open: "yes", balance: "lots" } }));
    const loaded = (await run(model.load(fake.service) as Effect.Effect<unknown>)) as { state: { open: boolean; balance: number; events: number } };
    expect(loaded.state).toEqual({ open: true, balance: 4, events: 5 }); // the true state, not the bad one
  });

  test("without a SnapshotStore in the context the model loads as if it declared nothing", async () => {
    const fake = makeInMemoryEventStore();
    fake.seed(Opened({ accountId: "a", initial: 0 }), ...deposits(4));
    const loaded = (await Effect.runPromise(Snap(1).of({ id: "a" }).load(fake.service) as unknown as Effect.Effect<{ state: { balance: number } }>));
    expect(loaded.state.balance).toBe(4);
  });

  test("with a store but no collector, the load works and records nothing", async () => {
    const fake = makeInMemoryEventStore();
    const snapshots = makeInMemorySnapshotStore();
    fake.seed(Opened({ accountId: "a", initial: 0 }), ...deposits(4));
    await Effect.runPromise(Effect.provide(Snap(1).of({ id: "a" }).load(fake.service), snapshots.layer) as Effect.Effect<unknown>);
    expect(snapshots.rows.size).toBe(0);
  });

  test("members of `all` snapshot independently and the combined load equals the full fold", async () => {
    const { fake, snapshots, run, loadAndFlush } = setup();
    fake.seed(Opened({ accountId: "a", initial: 10 }), Opened({ accountId: "b", initial: 0 }), ...deposits(4, "a"), ...deposits(4, "b"));
    const pair = (m: typeof Snap | (() => typeof Plain)) => all({ x: (m as typeof Snap)(2).of({ id: "a" }), y: (m as typeof Snap)(2).of({ id: "b" }) });
    await loadAndFlush(pair(Snap));
    expect(snapshots.rows.size).toBe(2);
    fake.seed(...deposits(1, "a"));
    const withSnapshots = (await run(pair(Snap).load(fake.service))) as { state: unknown };
    const reference = (await run(all({ x: Plain.of({ id: "a" }), y: Plain.of({ id: "b" }) }).load(fake.service))) as { state: unknown };
    expect(withSnapshots.state).toEqual(reference.state);
  });
});

describe("snapshot + tail equals the full fold (differential, random histories)", () => {
  const historyFor = (id: string) => (random: () => number) => {
    const n = 1 + Math.floor(random() * 40);
    const events = [Opened({ accountId: id, initial: Math.floor(random() * 100) })];
    for (let i = 0; i < n; i++) events.push(random() < 0.6 ? Deposited({ accountId: id, amount: 1 + Math.floor(random() * 9) }) : Withdrawn({ accountId: id, amount: 1 + Math.floor(random() * 5) }));
    return events;
  };

  test("a correct model passes over 300 random histories split at random points", async () => {
    await checkSnapshotEquivalence({ snapshotted: (id) => Snap(1).of({ id }), reference: (id) => Plain.of({ id }), id: "a", history: historyFor("a"), runs: 300 });
  });

  test("a model whose fold changed WITHOUT a version bump is caught", async () => {
    // the snapshot was written by version 1 of the fold; the fold then changed (deposits count double) and `version` was not bumped
    const Changed = defineModel({ by: "account_id", initial: () => ({ open: false, balance: 0, events: 0 }) })
      .on(Opened, (a, d) => ({ open: true, balance: d.initial, events: a.events + 1 }))
      .on(Deposited, (a, d) => ({ ...a, balance: a.balance + d.amount * 2, events: a.events + 1 }))
      .on(Withdrawn, (a, d) => ({ ...a, balance: a.balance - d.amount, events: a.events + 1 }));
    // run both versions against ONE store: write with the old fold, read with the new one, compare with the new fold's full result
    const fake = makeInMemoryEventStore();
    const snapshots = makeInMemorySnapshotStore();
    const layer = Layer.merge(snapshots.layer, SnapshotCollectorLive);
    fake.seed(Opened({ accountId: "a", initial: 0 }), ...deposits(5));
    await Effect.runPromise(Effect.provide(Effect.tap(Snap(1).of({ id: "a" }).load(fake.service), () => flushSnapshots), layer) as Effect.Effect<unknown>);
    fake.seed(...deposits(1));
    const stale = (await Effect.runPromise(Effect.provide(Changed.snapshot({ name: "account", version: 1, schema: State, every: 1 }).of({ id: "a" }).load(fake.service), layer) as unknown as Effect.Effect<{ state: { balance: number } }>)).state.balance;
    const truth = (await Effect.runPromise(Changed.of({ id: "a" }).load(fake.service) as unknown as Effect.Effect<{ state: { balance: number } }>)).state.balance;
    expect(stale).not.toBe(truth); // this is the failure the version number and `verify-snapshots` exist for
  });
});
