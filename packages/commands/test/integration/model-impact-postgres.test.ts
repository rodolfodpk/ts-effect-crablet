// Runs under Node (Testcontainers). The change-impact report fed with the tag keys of what is really stored (ADR-0017, DCB rule A).
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { Effect, Redacted } from "effect";
import * as Schema from "effect/Schema";
import { SqlClient } from "effect/sql";
import { startTestDb, type TestDb } from "@crablet/test-support";
import { EventStore } from "@crablet/eventstore";
import * as Crablet from "../../src/Crablet.ts";
import { defineEvent } from "../../src/Event.ts";
import { defineModel } from "../../src/Model.ts";
import { eventFactsFromLog, formatImpactReport, modelFactsOf, modelImpact } from "../../src/ModelImpact.ts";

const Opened = defineEvent("Opened", { schema: Schema.Struct({ walletId: Schema.String }), tags: (d) => ({ wallet_id: d.walletId }) });
const Deposited = defineEvent("Deposited", { schema: Schema.Struct({ walletId: Schema.String, depositId: Schema.String }), tags: (d) => ({ wallet_id: d.walletId, deposit_id: d.depositId }) });
const Reversed = defineEvent("Reversed", { schema: Schema.Struct({ walletId: Schema.String, depositId: Schema.String }), tags: (d) => ({ wallet_id: d.walletId, deposit_id: d.depositId }) });
const Transferred = defineEvent("Transferred", { schema: Schema.Struct({ from: Schema.String, to: Schema.String }), tags: (d) => ({ from_wallet_id: d.from, to_wallet_id: d.to }) });

let db: TestDb;
before(async () => { db = await startTestDb(); }, { timeout: 60_000 });
after(async () => { await db.stop(); });
const run = <A, E>(e: Effect.Effect<A, E, any>) =>
  Effect.runPromise(Effect.provide(e, Crablet.layer({ host: db.connInfo.host, port: db.connInfo.port, database: db.connInfo.database, username: db.connInfo.username, password: Redacted.make(db.connInfo.password) })) as Effect.Effect<A, E, never>);

describe("eventFactsFromLog", () => {
  it("lists, per event type in the log, the tag keys it carries; a model checked against them is told about the type it has not accounted for", { timeout: 60_000 }, async () => {
    const r = await run(Effect.gen(function* () {
      const es = yield* EventStore;
      yield* es.append([Opened({ walletId: "w" }), Deposited({ walletId: "w", depositId: "d" }), Transferred({ from: "w", to: "x" })]);
      yield* es.append([Reversed({ walletId: "w", depositId: "d" })]);
      const events = yield* eventFactsFromLog;
      const balance = defineModel({ by: "wallet_id", initial: () => ({ n: 0 }) }).lifecycle(Opened, (s) => s).on(Deposited, (s) => s);
      return { events, report: modelImpact({ events, models: [modelFactsOf("balance", balance.of({ id: "w" }))] }) };
    }));
    assert.deepStrictEqual(r.events, [
      { type: "Deposited", tagKeys: ["deposit_id", "wallet_id"] },
      { type: "Opened", tagKeys: ["wallet_id"] },
      { type: "Reversed", tagKeys: ["deposit_id", "wallet_id"] },
      { type: "Transferred", tagKeys: ["from_wallet_id", "to_wallet_id"] }
    ]);
    assert.deepStrictEqual(r.report.findings, [{ model: "balance", eventType: "Reversed", via: ["wallet_id"] }]);
    assert.ok(formatImpactReport(r.report).includes("NEW  balance: event Reversed"));
  });

  it("an empty log has no facts", { timeout: 60_000 }, async () => {
    const facts = await run(Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql.unsafe("DELETE FROM crablet_events"); // the tag rows go with them (ON DELETE CASCADE)
      return yield* eventFactsFromLog;
    }));
    assert.deepStrictEqual(facts, []);
  });
});
