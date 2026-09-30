// Runs under Node (Testcontainers). Races from the dcb.events examples (support/dcb-examples.ts) on real
// Postgres: each is "several actors, one invariant, exactly the right outcome".
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { Effect, Redacted } from "effect";
import { startTestDb, type TestDb } from "@crablet/test-support";
import { SqlClient } from "effect/sql";
import { EventStore } from "@crablet/eventstore";
import * as Crablet from "../../src/Crablet.ts";
import { CommandExecutor } from "../../src/CommandExecutor.ts";
import {
  ConfirmSignUp,
  CreateInvoice,
  RegisterAccount,
  SignUpInitiated,
  TokenInvalid,
  UsernameClaimed
} from "../support/dcb-examples.ts";

let db: TestDb;
before(async () => {
  db = await startTestDb();
}, { timeout: 60_000 });
after(async () => {
  await db.stop();
});

const AppLive = () =>
  Crablet.layer({
    host: db.connInfo.host,
    port: db.connInfo.port,
    database: db.connInfo.database,
    username: db.connInfo.username,
    password: Redacted.make(db.connInfo.password)
  });
const run = <A, E>(e: Effect.Effect<A, E, any>) => Effect.runPromise(Effect.provide(e, AppLive()) as Effect.Effect<A, E, never>);
const errorOf = (exit: any) => exit.cause?.reasons?.find((r: any) => r._tag === "Fail")?.error;
const exitAll = (effects: ReadonlyArray<Effect.Effect<any, any, any>>) =>
  Effect.all(effects.map((e) => Effect.exit(e)), { concurrency: effects.length });
const uid = () => crypto.randomUUID().slice(0, 8);

describe("dcb.events examples on Postgres", () => {
  it("unique username: two people registering the same name at once - exactly one gets it", async () => {
    const name = `user-${uid()}`;
    const exits = await run(
      Effect.gen(function* () {
        const executor = yield* CommandExecutor;
        return yield* exitAll([
          executor.run(RegisterAccount, { username: name, now: Date.now() }),
          executor.run(RegisterAccount, { username: name.toUpperCase(), now: Date.now() })
        ]);
      })
    );
    assert.equal(exits.filter((e) => e._tag === "Success").length, 1);
    assert.ok(errorOf(exits.find((e) => e._tag === "Failure")) instanceof UsernameClaimed);
  });

  it("invoice numbers: concurrent creations get distinct, consecutive numbers (gap-free)", async () => {
    // a fresh container per file, so the series starts at 1. Four racers need at most three retries.
    const numbers = await run(
      Effect.gen(function* () {
        const executor = yield* CommandExecutor;
        const sql = yield* SqlClient.SqlClient;
        const exits = yield* exitAll([1, 2, 3, 4].map((n) => executor.run(CreateInvoice, { invoiceData: `inv ${n}` })));
        assert.deepEqual(exits.map((e) => e._tag), ["Success", "Success", "Success", "Success"]);
        const rows = yield* sql<{ n: number }>`
          SELECT (data->>'invoiceNumber')::int AS n FROM crablet_events WHERE type = 'InvoiceCreated' ORDER BY position`;
        return rows.map((r) => r.n);
      })
    );
    assert.deepEqual(numbers, [1, 2, 3, 4]);
  });

  it("opt-in token: two confirmations of the same token at once - exactly one succeeds", async () => {
    const email = `ann-${uid()}@example.com`;
    const otp = uid();
    const exits = await run(
      Effect.gen(function* () {
        const es = yield* EventStore;
        yield* es.append([SignUpInitiated({ email, otp, name: "Ann" })]);
        const executor = yield* CommandExecutor;
        return yield* exitAll([
          executor.run(ConfirmSignUp, { email, otp, now: Date.now() }),
          executor.run(ConfirmSignUp, { email, otp, now: Date.now() })
        ]);
      })
    );
    assert.equal(exits.filter((e) => e._tag === "Success").length, 1);
    assert.equal((errorOf(exits.find((e) => e._tag === "Failure")) as TokenInvalid).reason, "already used");
  });
});
