// Runs under Node (Testcontainers). The executor writes the snapshots a command's load recorded, AFTER the command's transaction ended (ADR-0018, spike: a write
// from inside the transaction deadlocks a small pool).
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { Effect, Layer, Redacted } from "effect";
import * as Schema from "effect/Schema";
import { PgClient } from "@effect/sql-pg";
import { startTestDb, type TestDb } from "@crablet/test-support";
import { EventStore, EventStoreLive } from "@crablet/eventstore";
import { CommandAuditStoreLive } from "@crablet/eventstore/CommandAuditStore";
import { SnapshotStore, canonicalQuery } from "@crablet/eventstore/SnapshotStore";
import * as Crablet from "../../src/Crablet.ts";
import { CommandExecutor, CommandExecutorLive } from "../../src/CommandExecutor.ts";
import { defineCommand, emit, fail } from "../../src/Command.ts";
import { DomainError } from "../../src/Errors.ts";
import { defineEvent } from "../../src/Event.ts";
import { defineModel } from "../../src/Model.ts";
import { AuditConfigRef } from "../../src/CommandAudit.ts";

const Opened = defineEvent("Opened", { schema: Schema.Struct({ accountId: Schema.String }), tags: (d) => ({ account_id: d.accountId }) });
const Deposited = defineEvent("Deposited", { schema: Schema.Struct({ accountId: Schema.String, amount: Schema.Number }), tags: (d) => ({ account_id: d.accountId }) });
class NotPositive extends DomainError("NotPositive", { fields: { amount: Schema.Number }, kind: "conflict" }) {}

const State = Schema.Struct({ open: Schema.Boolean, balance: Schema.Number, events: Schema.Number });
const base = () =>
  defineModel({ by: "account_id", initial: () => ({ open: false, balance: 0, events: 0 }) })
    .on(Opened, (a) => ({ ...a, open: true, events: a.events + 1 }))
    .on(Deposited, (a, d) => ({ ...a, balance: a.balance + d.amount, events: a.events + 1 }));
const Snap = base().snapshot({ name: "account", version: 1, schema: State, every: 3 });
const Plain = base();

const commandOn = (model: typeof Snap) =>
  defineCommand({
    name: "deposit",
    errors: [NotPositive],
    input: Schema.Struct({ accountId: Schema.String, amount: Schema.Number }),
    model: (c) => model.of({ id: c.accountId }),
    decide: (_state, c) => (c.amount <= 0 ? fail(new NotPositive({ amount: c.amount })) : emit(Deposited({ accountId: c.accountId, amount: c.amount })))
  });
const Deposit = commandOn(Snap);

let db: TestDb;
before(async () => { db = await startTestDb(); }, { timeout: 60_000 });
after(async () => { await db.stop(); });

const pg = (maxConnections = 10) => ({ host: db.connInfo.host, port: db.connInfo.port, database: db.connInfo.database, username: db.connInfo.username, password: Redacted.make(db.connInfo.password), maxConnections });
const run = <A, E>(e: Effect.Effect<A, E, any>, maxConnections = 10) => Effect.runPromise(Effect.provide(e, Crablet.layer(pg(maxConnections))) as Effect.Effect<A, E, never>);
const uid = () => crypto.randomUUID().slice(0, 8);
const seed = (id: string, deposits: number) =>
  Effect.flatMap(EventStore, (es) => es.append([Opened({ accountId: id }), ...Array.from({ length: deposits }, () => Deposited({ accountId: id, amount: 1 }))]));
const stored = (id: string) => Effect.flatMap(SnapshotStore, (s) => s.get({ name: "account", version: 1, canonical: canonicalQuery(Snap.of({ id }).query) }));

describe("the executor writes the snapshots a load recorded", () => {
  it("a command that loaded enough events leaves a snapshot of the state it loaded", async () => {
    const id = `a-${uid()}`;
    const row = await run(Effect.gen(function* () {
      yield* seed(id, 5); // 6 events
      yield* (yield* CommandExecutor).run(Deposit, { accountId: id, amount: 10 });
      return yield* stored(id);
    }));
    assert.deepStrictEqual(row!.state, { open: true, balance: 5, events: 6 }, "the state the command DECIDED on (its own new event is after the cursor)");
    assert.strictEqual(row!.cursor.position > 0n, true);
  });

  it("the next command reads only the tail, and the state stays equal to the full fold", async () => {
    const id = `a-${uid()}`;
    const r = await run(Effect.gen(function* () {
      yield* seed(id, 5);
      const executor = yield* CommandExecutor;
      yield* executor.run(Deposit, { accountId: id, amount: 10 }); // snapshot at 6 events; 7th event appended
      yield* executor.run(Deposit, { accountId: id, amount: 10 }); // loads snapshot + 1 event: below `every`, no new write
      const es = yield* EventStore;
      return { row: yield* stored(id), snap: (yield* Snap.of({ id }).load(es)).state, plain: (yield* base().of({ id }).load(es)).state };
    }));
    assert.deepStrictEqual(r.snap, r.plain);
    assert.deepStrictEqual(r.snap, { open: true, balance: 25, events: 8 });
    assert.deepStrictEqual(r.row!.state, { open: true, balance: 5, events: 6 }, "unchanged: the second command folded 1 event, under `every`");
  });

  it("a command that FAILS in its domain still leaves the snapshot (the state it loaded is valid either way)", async () => {
    const id = `a-${uid()}`;
    const r = await run(Effect.gen(function* () {
      yield* seed(id, 5);
      const exit = yield* Effect.exit((yield* CommandExecutor).run(Deposit, { accountId: id, amount: -1 }));
      return { failed: exit._tag === "Failure", row: yield* stored(id) };
    }));
    assert.strictEqual(r.failed, true);
    assert.deepStrictEqual(r.row!.state, { open: true, balance: 5, events: 6 });
  });

  it("a command on a model WITHOUT a snapshot writes nothing", async () => {
    const id = `a-${uid()}`;
    const row = await run(Effect.gen(function* () {
      yield* seed(id, 5);
      yield* (yield* CommandExecutor).run(commandOn(Plain as never), { accountId: id, amount: 1 });
      return yield* stored(id);
    }));
    assert.strictEqual(row, null);
  });

  it("with the pool as small as the load, snapshots are written and no command deadlocks (the case the spike found)", { timeout: 60_000 }, async () => {
    const ids = Array.from({ length: 8 }, () => `a-${uid()}`);
    const r = await run(Effect.gen(function* () {
      for (const id of ids) yield* seed(id, 5);
      const executor = yield* CommandExecutor;
      const exits = yield* Effect.all(ids.map((id) => Effect.exit(Effect.timeout(executor.run(Deposit, { accountId: id, amount: 1 }), "10 seconds"))), { concurrency: 8 });
      const rows = yield* Effect.forEach(ids, stored);
      return { ok: exits.filter((e) => e._tag === "Success").length, snapshots: rows.filter((x) => x !== null).length };
    }), 2);
    assert.deepStrictEqual(r, { ok: 8, snapshots: 8 });
  });

  it("an executor built WITHOUT a SnapshotStore runs a snapshotted model like a plain one", async () => {
    const id = `a-${uid()}`;
    const layer = Layer.provideMerge(
      Layer.mergeAll(CommandExecutorLive, EventStoreLive, CommandAuditStoreLive, Layer.succeed(AuditConfigRef, { payload: "redacted" })),
      PgClient.layer(pg())
    );
    const balance = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          yield* seed(id, 5);
          yield* (yield* CommandExecutor).run(Deposit, { accountId: id, amount: 1 });
          return (yield* Snap.of({ id }).load(yield* EventStore)).state.balance;
        }),
        layer
      ) as Effect.Effect<number>
    );
    assert.strictEqual(balance, 6);
  });
});
