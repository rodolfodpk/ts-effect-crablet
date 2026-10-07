import { describe, expect, test } from "bun:test";
import { Effect, Layer } from "effect";
import * as Schema from "effect/Schema";
import { makeInMemoryEventStore } from "@crablet/eventstore/testing/InMemoryEventStore";
import { makeInMemorySnapshotStore } from "@crablet/eventstore/testing/InMemorySnapshotStore";
import { EventStore } from "@crablet/eventstore";
import { SnapshotCollectorLive, canonicalQuery, flushSnapshots } from "@crablet/eventstore/SnapshotStore";
import { defineEvent } from "../src/Event.ts";
import { defineModel } from "../src/Model.ts";
import { formatSnapshotReport, verifySnapshots } from "../src/VerifySnapshots.ts";

const Opened = defineEvent("Opened", { schema: Schema.Struct({ accountId: Schema.String }), tags: (d) => ({ account_id: d.accountId }) });
const Deposited = defineEvent("Deposited", { schema: Schema.Struct({ accountId: Schema.String, amount: Schema.Number }), tags: (d) => ({ account_id: d.accountId }) });
const Fee = defineEvent("Fee", { schema: Schema.Struct({ accountId: Schema.String, amount: Schema.Number }), tags: (d) => ({ account_id: d.accountId }) });

const State = Schema.Struct({ balance: Schema.Number });
const account = (opts: { version?: number; depositFactor?: number; withFee?: boolean } = {}) => {
  let m = defineModel({ by: "account_id", initial: () => ({ balance: 0 }) })
    .on(Opened, (a) => a)
    .on(Deposited, (a, d) => ({ balance: a.balance + d.amount * (opts.depositFactor ?? 1) }));
  if (opts.withFee) m = m.on(Fee, (a, d) => ({ balance: a.balance - d.amount }));
  return m.snapshot({ name: "account", version: opts.version ?? 1, schema: State, every: 1 });
};

const world = async (ids: ReadonlyArray<string>) => {
  const fake = makeInMemoryEventStore();
  const snapshots = makeInMemorySnapshotStore();
  const layer = Layer.mergeAll(snapshots.layer, SnapshotCollectorLive, Layer.succeed(EventStore, fake.service));
  const run = <A>(e: Effect.Effect<A, unknown, any>) => Effect.runPromise(Effect.provide(e, layer) as Effect.Effect<A>);
  for (const id of ids) {
    fake.seed(Opened({ accountId: id }), Deposited({ accountId: id, amount: 5 }), Deposited({ accountId: id, amount: 7 }));
    await run(Effect.tap(account().of({ id }).load(fake.service), () => flushSnapshots)); // what a command leaves behind
  }
  fake.seed(...ids.map((id) => Deposited({ accountId: id, amount: 1 }))); // a tail after every snapshot
  return { fake, snapshots, run };
};
const verifier = (opts: Parameters<typeof account>[0] = {}) => ({ name: "account", instance: (entity: unknown) => account(opts).of(entity as { id: string }) });

describe("verifySnapshots", () => {
  test("snapshots written by the model's own fold verify clean", async () => {
    const { run } = await world(["a", "b", "c"]);
    const report = await run(verifySnapshots({ models: [verifier()] }));
    expect(report.ok).toBe(true);
    expect(report.models[0]).toMatchObject({ name: "account", version: 1, checked: 3, problems: [] });
    expect(report.rows).toEqual([{ name: "account", version: 1, count: 3 }]);
    expect(formatSnapshotReport(report)).toContain("account: 3 checked, all consistent");
  });

  test("a fold that changed WITHOUT a version bump is reported as a mismatch, with both states", async () => {
    const { run } = await world(["a", "b"]);
    const report = await run(verifySnapshots({ models: [verifier({ depositFactor: 2 })] }));
    expect(report.ok).toBe(false);
    const problems = report.models[0]!.problems;
    expect(problems.length).toBe(2);
    expect(problems[0]!.kind).toBe("mismatch");
    expect(problems[0]!.detail).toContain("with the snapshot");
    expect(formatSnapshotReport(report)).toContain("FAILED");
  });

  test("bumping the version is the fix: the old rows are no longer the current model's, and are listed as unaccounted", async () => {
    const { run } = await world(["a"]);
    const report = await run(verifySnapshots({ models: [verifier({ depositFactor: 2, version: 2 })] }));
    expect(report.ok).toBe(true);
    expect(report.models[0]!.checked).toBe(0); // no row of version 2 exists yet, and the v1 row is not checked against a model that no longer reads it
    expect(report.unaccounted).toEqual([{ name: "account", version: 1, count: 1 }]);
    expect(formatSnapshotReport(report)).toContain("account v1 x1");
  });

  test("a changed set of handled events changes the boundary: the row is reported stale", async () => {
    const { run } = await world(["a"]);
    const report = await run(verifySnapshots({ models: [verifier({ withFee: true })] }));
    expect(report.ok).toBe(false);
    expect(report.models[0]!.problems[0]!.kind).toBe("stale_boundary");
  });

  test("a stored state that no longer decodes is reported", async () => {
    const { run, snapshots } = await world(["a"]);
    const model = account().of({ id: "a" });
    await Effect.runPromise(snapshots.service.save({ name: "account", version: 1, canonical: canonicalQuery(model.query), cursor: { position: 99n, occurredAt: null, transactionId: "99" }, state: { balance: "lots" }, entity: { id: "a" } }));
    const report = await run(verifySnapshots({ models: [verifier()] }));
    expect(report.models[0]!.problems.map((p) => p.kind)).toEqual(["undecodable"]);
  });

  test("a row without an entity is unverifiable, which does not fail the run", async () => {
    const { run, snapshots } = await world([]);
    const model = account().of({ id: "x" });
    await Effect.runPromise(snapshots.service.save({ name: "account", version: 1, canonical: canonicalQuery(model.query), cursor: { position: 1n, occurredAt: null, transactionId: "1" }, state: { balance: 0 } }));
    const report = await run(verifySnapshots({ models: [verifier()] }));
    expect(report.ok).toBe(true);
    expect(report.models[0]!.problems.map((p) => p.kind)).toEqual(["unverifiable"]);
    expect(formatSnapshotReport(report)).toContain("1 unverifiable");
  });

  test("rows of a name no registered model accounts for are listed, not checked", async () => {
    const { run, snapshots } = await world(["a"]);
    await Effect.runPromise(snapshots.service.save({ name: "other-app", version: 3, canonical: "q", cursor: { position: 1n, occurredAt: null, transactionId: "1" }, state: {}, entity: { id: "z" } }));
    const report = await run(verifySnapshots({ models: [verifier()] }));
    expect(report.unaccounted).toEqual([{ name: "other-app", version: 3, count: 1 }]);
    expect(report.ok).toBe(true);
  });

  test("the sample limits how many rows are folded", async () => {
    const { run } = await world(["a", "b", "c", "d", "e"]);
    const report = await run(verifySnapshots({ models: [verifier()], sample: 2 }));
    expect(report.models[0]!.checked).toBe(2);
  });

  test("an event appended between the two loads is not reported: the mismatch is loaded again", async () => {
    const check = async (attempts: number) => {
      const w = await world(["a"]);
      let first = true;
      // the first load of the pair completes, then a command appends before the second: the positions differ once, then agree
      const racing = { ...w.fake.service, project: (q: never, after: never, p: never) => Effect.tap(w.fake.service.project(q, after, p), () => Effect.sync(() => { if (first) { first = false; w.fake.seed(Deposited({ accountId: "a", amount: 1 })); } })) };
      const layer = Layer.merge(w.snapshots.layer, Layer.succeed(EventStore, racing as never));
      return Effect.runPromise(Effect.provide(verifySnapshots({ models: [verifier()], attempts }), layer) as unknown as Effect.Effect<{ ok: boolean }>);
    };
    expect((await check(3)).ok).toBe(true);
    expect((await check(1)).ok).toBe(false); // without the retry the same race would be reported as a bug
  });
});
