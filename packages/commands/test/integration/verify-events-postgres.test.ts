// Runs under Node (Testcontainers). verify-events (ADR-0017) against a real log: stored events are decoded by type with the CURRENT definitions.
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { Effect, Redacted } from "effect";
import * as Schema from "effect/Schema";
import { SqlClient } from "effect/sql";
import { startTestDb, type TestDb } from "@crablet/test-support";
import * as Crablet from "../../src/Crablet.ts";
import { defineEvent } from "../../src/Event.ts";
import { formatEventsReport, verifyEvents } from "../../src/VerifyEvents.ts";

// Deposit as it is now: `fee` was added with a default (compatible); `currency` was added as REQUIRED (not compatible: events written before it cannot be read)
const Deposit = defineEvent("Deposit", {
  schema: Schema.Struct({ id: Schema.String, amount: Schema.Number, currency: Schema.String }),
  tags: (d) => ({ deposit_id: d.id })
});
const Tagged = defineEvent("Tagged", { schema: Schema.Struct({ id: Schema.String }), tags: (d) => ({ item_id: d.id, class: "new" }) }); // derives a tag old events lack
const Fine = defineEvent("Fine", { schema: Schema.Struct({ id: Schema.String }), tags: (d) => ({ item_id: d.id }) });

let db: TestDb;
before(async () => { db = await startTestDb(); }, { timeout: 60_000 });
after(async () => { await db.stop(); });
const run = <A, E>(e: Effect.Effect<A, E, any>) =>
  Effect.runPromise(Effect.provide(e, Crablet.layer({ host: db.connInfo.host, port: db.connInfo.port, database: db.connInfo.database, username: db.connInfo.username, password: Redacted.make(db.connInfo.password) })) as Effect.Effect<A, E, never>);
const insert = (type: string, tags: ReadonlyArray<string>, data: unknown) =>
  Effect.flatMap(SqlClient.SqlClient, (sql) => sql.unsafe<{ position: string }>("INSERT INTO crablet_events (type, tags, data, transaction_id) VALUES ($1, $2::text[], $3::jsonb, pg_current_xact_id()) RETURNING position::text AS position", [type, `{${tags.join(",")}}`, JSON.stringify(data)]));

describe("verifyEvents", () => {
  it("decodes the stored events of each type: counts, the positions of the unreadable ones, what is wrong with them, unknown types, and tag drift", { timeout: 60_000 }, async () => {
    const r = await run(Effect.gen(function* () {
      const good: string[] = [], old: string[] = [];
      for (let i = 0; i < 6; i++) good.push((yield* insert("Deposit", [`deposit_id=g${i}`], { id: `g${i}`, amount: 1, currency: "EUR" }))[0]!.position);
      for (let i = 0; i < 4; i++) old.push((yield* insert("Deposit", [`deposit_id=o${i}`], { id: `o${i}`, amount: 1 }))[0]!.position); // written before `currency`
      yield* insert("Fine", ["item_id=a"], { id: "a" });
      yield* insert("Tagged", ["item_id=a"], { id: "a" }); // stored without the `class` tag the definition derives now
      yield* insert("Legacy", ["x=1"], { anything: true }); // no definition at all
      yield* insert("Legacy", ["x=2"], {});
      const report = yield* verifyEvents({ definitions: [Deposit, Fine, Tagged], all: true });
      return { good, old, report };
    }));
    const byType = Object.fromEntries(r.report.types.map((t) => [t.type, t]));
    assert.deepStrictEqual({ total: byType["Deposit"]!.total, checked: byType["Deposit"]!.checked, failures: byType["Deposit"]!.failures }, { total: 10, checked: 10, failures: 4 });
    assert.deepStrictEqual(byType["Deposit"]!.failingPositions.map(String), r.old);
    assert.deepStrictEqual(byType["Deposit"]!.issues, [{ path: ["currency"], message: "Missing key", count: 4 }]);
    assert.strictEqual(byType["Fine"]!.failures, 0);
    assert.strictEqual(byType["Tagged"]!.failures, 0);
    assert.strictEqual(byType["Tagged"]!.inventedTags, 1, "the definition derives class=new, which the stored event does not have");
    assert.deepStrictEqual(r.report.unknownTypes, [{ type: "Legacy", count: 2 }]);
    assert.strictEqual(r.report.ok, false);
    const text = formatEventsReport(r.report);
    assert.ok(text.includes("Deposit: 4 of 10 cannot be read"), text);
    assert.ok(text.includes("Missing key at currency"), text);
    assert.ok(text.includes("Legacy"), text);
  });

  it("a sample checks at most that many events per type; `all` checks every one, in batches; a position range and a type filter narrow it", { timeout: 60_000 }, async () => {
    const r = await run(Effect.gen(function* () {
      const positions: string[] = [];
      for (let i = 0; i < 12; i++) positions.push((yield* insert("Fine", [`item_id=s${i}`], i % 3 === 0 ? { nope: i } : { id: `s${i}` }))[0]!.position);
      yield* insert("Deposit", ["deposit_id=z"], { id: "z", amount: 1, currency: "EUR" });
      const from = BigInt(positions[0]!), to = BigInt(positions[11]!);
      const sampled = yield* verifyEvents({ definitions: [Fine, Deposit], sample: 5, fromPosition: from, toPosition: to });
      const everything = yield* verifyEvents({ definitions: [Fine], all: true, batchSize: 5, fromPosition: from, toPosition: to });
      const onlyDeposit = yield* verifyEvents({ definitions: [Fine, Deposit], types: ["Deposit"] });
      return { sampled, everything, onlyDeposit };
    }));
    const fine = r.sampled.types.find((t) => t.type === "Fine")!;
    assert.deepStrictEqual({ total: fine.total, checked: fine.checked }, { total: 12, checked: 5 });
    assert.strictEqual(r.sampled.types.find((t) => t.type === "Deposit")!.total, 0, "the range excludes the Deposit written after it");
    const every = r.everything.types[0]!;
    assert.deepStrictEqual({ total: every.total, checked: every.checked, failures: every.failures }, { total: 12, checked: 12, failures: 4 });
    assert.deepStrictEqual(r.onlyDeposit.types.map((t) => t.type), ["Deposit"]);
  });

  it("an empty log, and a log of readable events, are ok", { timeout: 60_000 }, async () => {
    const ok = await run(Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql.unsafe("DELETE FROM crablet_events");
      const empty = yield* verifyEvents({ definitions: [Fine], all: true });
      yield* insert("Fine", ["item_id=a"], { id: "a" });
      const one = yield* verifyEvents({ definitions: [Fine], all: true });
      return { empty, one };
    }));
    assert.strictEqual(ok.empty.ok, true);
    assert.strictEqual(ok.one.ok, true);
    assert.strictEqual(ok.one.types[0]!.checked, 1);
  });
});
