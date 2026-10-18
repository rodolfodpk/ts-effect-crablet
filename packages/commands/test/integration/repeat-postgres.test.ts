// Runs under Node (Testcontainers). A repeat must be the same request (ADR-0034), on real Postgres: the fingerprint is stored with the events, a repeat answers
// with the earlier write's marker, and the same key from another request is refused - also when the two race past the check before the append.
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { Deferred, Effect, Exit, Redacted } from "effect";
import { SqlClient } from "effect/sql";
import * as Schema from "effect/Schema";
import { startTestDb, type TestDb } from "@crablet/test-support";
import * as Crablet from "../../src/Crablet.ts";
import { CommandExecutor } from "../../src/CommandExecutor.ts";
import { byModel, defineCommand, emit } from "../../src/Command.ts";
import { defineModel } from "../../src/Model.ts";
import { IdempotencyMismatch } from "../../src/Errors.ts";
import { defineEvent } from "../../src/Event.ts";

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
const runExit = <A, E>(e: Effect.Effect<A, E, any>) => Effect.runPromiseExit(Effect.provide(e, AppLive()) as Effect.Effect<A, E, never>);

const Paid = defineEvent("RPG_Paid", { schema: Schema.Struct({ paymentId: Schema.String, amount: Schema.Number }), tags: (d) => ({ payment_id: d.paymentId }) });
const payInput = Schema.Struct({ paymentId: Schema.String, amount: Schema.Number });
const Pay = defineCommand({ name: "rpg_pay", input: payInput, idempotentBy: (c) => Paid.where({ payment_id: c.paymentId }), decide: (_, c) => emit(Paid(c)) });

const stored = (paymentId: string) =>
  run(
    Effect.flatMap(SqlClient.SqlClient, (sql) =>
      sql.unsafe<{ amount: number; fingerprint: string | null }>(
        "SELECT (data->>'amount')::int AS amount, encode(request_fingerprint, 'hex') AS fingerprint FROM crablet_events WHERE type = 'RPG_Paid' AND tags @> ARRAY[$1]::text[]",
        [`payment_id=${paymentId}`]
      )
    )
  );

describe("a repeat must be the same request (ADR-0034, real Postgres)", () => {
  it("stores the request's fingerprint, answers a repeat with the earlier write's marker, and refuses another request under the same key", { timeout: 30_000 }, async () => {
    const paymentId = crypto.randomUUID();
    const first = await run(Effect.flatMap(CommandExecutor, (x) => x.run(Pay, { paymentId, amount: 10 })));
    const again = await run(Effect.flatMap(CommandExecutor, (x) => x.run(Pay, { paymentId, amount: 10 })));
    assert.equal(again.wasIdempotent, true);
    assert.deepEqual([again.lastPosition, again.lastTransactionId], [first.lastPosition, first.lastTransactionId]);

    const other = await runExit(Effect.flatMap(CommandExecutor, (x) => x.run(Pay, { paymentId, amount: 20 })));
    assert.ok(Exit.isFailure(other) && String(other.cause).includes("IdempotencyMismatch"));

    const rows = await stored(paymentId);
    assert.deepEqual(rows.map((r) => r.amount), [10]);
    assert.match(rows[0]!.fingerprint ?? "", /^[0-9a-f]{64}$/, "a SHA-256 is stored with the event");
  });

  it("two DIFFERENT requests under one key that both pass the check before either appends: one is applied, the other is refused at the append", { timeout: 30_000 }, async () => {
    const paymentId = crypto.randomUUID();
    const results = await run(
      Effect.gen(function* () {
        const executor = yield* CommandExecutor;
        const bothChecked = yield* Deferred.make<void>();
        let arrived = 0;
        // `resolve` runs after the idempotency check: both wait there until both have passed it, then append.
        const Racing = defineCommand({
          name: "rpg_pay_racing",
          input: payInput,
          idempotentBy: (c) => Paid.where({ payment_id: c.paymentId }),
          resolve: () => Effect.suspend(() => (++arrived === 2 ? Deferred.succeed(bothChecked, undefined) : Effect.void)).pipe(Effect.andThen(Deferred.await(bothChecked))),
          decide: (_, c) => emit(Paid(c))
        });
        return yield* Effect.all([Effect.exit(executor.run(Racing, { paymentId, amount: 10 })), Effect.exit(executor.run(Racing, { paymentId, amount: 20 }))], { concurrency: 2 });
      })
    );
    const applied = results.filter(Exit.isSuccess);
    const refused = results.filter((r) => Exit.isFailure(r) && String(r.cause).includes("IdempotencyMismatch"));
    assert.equal(applied.length, 1, "one request is applied");
    assert.equal(refused.length, 1, "the other is refused, not answered 'already done'");
    assert.equal((await stored(paymentId)).length, 1);
  });

  it("IdempotencyMismatch is a typed failure a caller can catch", { timeout: 30_000 }, async () => {
    const paymentId = crypto.randomUUID();
    await run(Effect.flatMap(CommandExecutor, (x) => x.run(Pay, { paymentId, amount: 10 })));
    const caught = await run(
      Effect.flatMap(CommandExecutor, (x) => x.run(Pay, { paymentId, amount: 30 })).pipe(
        Effect.map(() => "applied"),
        Effect.catchTag("IdempotencyMismatch", (e) => Effect.succeed(e instanceof IdempotencyMismatch ? e.command : "?"))
      )
    );
    assert.equal(caught, "rpg_pay");
  });
});

describe("byModel() is checked on every write (ADR-0034, real Postgres)", () => {
  it("a command whose decide does not answer its own repeat is refused before anything is appended", { timeout: 30_000 }, async () => {
    const Noted = defineEvent("RPG_Noted", { schema: Schema.Struct({ noteId: Schema.String }), tags: (d) => ({ note_id: d.noteId }) });
    const NoteModel = defineModel({ by: "note_id", initial: () => ({ noted: false }) }).on(Noted, () => ({ noted: true }));
    // It says the model shows the note was taken, but it never looks.
    const Note = defineCommand({
      name: "rpg_note",
      input: Schema.Struct({ noteId: Schema.String }),
      model: (c) => NoteModel.of({ id: c.noteId }),
      idempotentBy: byModel(),
      decide: (_, c) => emit(Noted(c))
    });
    const noteId = crypto.randomUUID();
    const exit = await runExit(Effect.flatMap(CommandExecutor, (x) => x.run(Note, { noteId })));
    assert.ok(Exit.isFailure(exit), "refused");
    const rows = await run(Effect.flatMap(SqlClient.SqlClient, (sql) => sql.unsafe("SELECT 1 FROM crablet_events WHERE tags @> ARRAY[$1]::text[]", [`note_id=${noteId}`])));
    assert.equal(rows.length, 0, "nothing appended");
  });
});
