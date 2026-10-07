// Runs under Node (Testcontainers). verify-snapshots against snapshots written by real commands (ADR-0018).
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { Effect, Redacted } from "effect";
import * as Schema from "effect/Schema";
import { startTestDb, type TestDb } from "@crablet/test-support";
import { EventStore } from "@crablet/eventstore";
import { SnapshotStore } from "@crablet/eventstore/SnapshotStore";
import { SqlClient } from "effect/sql";
import * as Crablet from "../../src/Crablet.ts";
import { CommandExecutor } from "../../src/CommandExecutor.ts";
import { defineCommand, emit } from "../../src/Command.ts";
import { defineEvent } from "../../src/Event.ts";
import { defineModel } from "../../src/Model.ts";
import { verifySnapshots, formatSnapshotReport } from "../../src/VerifySnapshots.ts";

const Opened = defineEvent("Opened", { schema: Schema.Struct({ accountId: Schema.String, year: Schema.Number }), tags: (d) => ({ account_id: d.accountId, year: String(d.year) }) });
const Deposited = defineEvent("Deposited", { schema: Schema.Struct({ accountId: Schema.String, year: Schema.Number, amount: Schema.Number }), tags: (d) => ({ account_id: d.accountId, year: String(d.year) }) });
const State = Schema.Struct({ balance: Schema.Number });
// a model with a SCOPE (an account's balance within a year): its `of` arguments are { id, year }
const Yearly = defineModel<{ balance: number }, { year: number }>({ by: "account_id", initial: () => ({ balance: 0 }), scope: (s) => ({ year: s.year }) })
  .on(Opened, (a) => a)
  .on(Deposited, (a, d) => ({ balance: a.balance + d.amount }))
  .snapshot({ name: "yearly", version: 1, schema: State, every: 2 });
const Deposit = defineCommand({
  name: "deposit_yearly",
  errors: [],
  input: Schema.Struct({ accountId: Schema.String, year: Schema.Number, amount: Schema.Number }),
  model: (c) => Yearly.of({ id: c.accountId, year: c.year }),
  decide: (_m, c) => emit(Deposited(c))
});

let db: TestDb;
before(async () => { db = await startTestDb(); }, { timeout: 60_000 });
after(async () => { await db.stop(); });
const run = <A, E>(e: Effect.Effect<A, E, any>) =>
  Effect.runPromise(Effect.provide(e, Crablet.layer({ host: db.connInfo.host, port: db.connInfo.port, database: db.connInfo.database, username: db.connInfo.username, password: Redacted.make(db.connInfo.password) })) as Effect.Effect<A, E, never>);
const uid = () => crypto.randomUUID().slice(0, 8);
const registry = [{ name: "yearly", instance: (entity: unknown) => Yearly.of(entity as { id: string; year: number }) }];

describe("verify-snapshots on real Postgres", () => {
  it("snapshots left by commands (with their scope in the entity) verify clean; a corrupted one is found", { timeout: 60_000 }, async () => {
    const ids = [`a-${uid()}`, `b-${uid()}`, `c-${uid()}`];
    const r = await run(Effect.gen(function* () {
      const executor = yield* CommandExecutor;
      const es = yield* EventStore;
      for (const id of ids) {
        yield* es.append([Opened({ accountId: id, year: 2026 })]);
        for (let i = 0; i < 5; i++) yield* executor.run(Deposit, { accountId: id, year: 2026, amount: 10 });
      }
      const clean = yield* verifySnapshots({ models: registry });
      const store = yield* SnapshotStore;
      const sample = yield* store.list({ name: "yearly", limit: 1 });
      // corrupt one row so that it still decodes but is WRONG (as a fold that changed without a version bump would leave it)
      const sql = yield* SqlClient.SqlClient;
      yield* sql.unsafe("UPDATE crablet_model_snapshots SET state = jsonb_set(state, '{balance}', '999999') WHERE name = 'yearly' AND entity->>'id' = $1", [ids[1]]);
      const corrupted = yield* verifySnapshots({ models: registry });
      return { clean, corrupted, sample };
    }));
    assert.strictEqual(r.clean.ok, true, formatSnapshotReport(r.clean));
    assert.strictEqual(r.clean.models[0]!.checked, 3);
    assert.deepStrictEqual(r.sample[0]!.entity && Object.keys(r.sample[0]!.entity as object).sort(), ["id", "year"], "the stored entity carries the model's scope");
    assert.strictEqual(r.corrupted.ok, false);
    assert.deepStrictEqual(r.corrupted.models[0]!.problems.map((p) => p.kind), ["mismatch"]);
    assert.deepStrictEqual((r.corrupted.models[0]!.problems[0]!.entity as { id: string }).id, ids[1]);
    assert.ok(formatSnapshotReport(r.corrupted).includes('folding the whole boundary {"balance":50}'), "the report shows what the full fold gives (5 deposits of 10)");
  });

  it("summary counts rows per model and version; a sample never exceeds its limit", async () => {
    const r = await run(Effect.gen(function* () {
      const store = yield* SnapshotStore;
      return { summary: yield* store.summary, list: yield* store.list({ name: "yearly", limit: 2 }) };
    }));
    assert.ok(r.summary.some((s) => s.name === "yearly" && s.version === 1 && s.count >= 3));
    assert.ok(r.list.length <= 2);
  });
});
