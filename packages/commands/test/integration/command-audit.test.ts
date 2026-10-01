// Runs under Node (Testcontainers). The command audit: one redacted row per command that appended events, written in
// the command's own transaction.
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { Duration, Effect, Fiber, Redacted } from "effect";
import * as Schema from "effect/Schema";
import { SqlClient } from "effect/sql";
import { startTestDb, type TestDb } from "@crablet/test-support";
import * as CorrelationContext from "@crablet/eventstore/CorrelationContext";
import * as Crablet from "../../src/Crablet.ts";
import { CommandExecutor } from "../../src/CommandExecutor.ts";
import { AuditConfigRef, purgeCommandAudit, startAuditRetention, withActor, type AuditPayload } from "../../src/CommandAudit.ts";
import { defineCommand, emit, fail } from "../../src/Command.ts";
import { DomainError } from "../../src/Errors.ts";
import { defineEvent } from "../../src/Event.ts";
import { defineModel } from "../../src/Model.ts";
import { personal } from "../../src/Personal.ts";
import { afterLoad, barrier } from "../support/barrier.ts";

let db: TestDb;
before(async () => {
  db = await startTestDb();
}, { timeout: 60_000 });
after(async () => {
  await db.stop();
});

const AppLive = (audit?: { payload: AuditPayload }) =>
  Crablet.layer(
    { host: db.connInfo.host, port: db.connInfo.port, database: db.connInfo.database, username: db.connInfo.username, password: Redacted.make(db.connInfo.password) },
    audit ? { audit } : {}
  );
const run = <A, E>(e: Effect.Effect<A, E, any>, audit?: { payload: AuditPayload }) =>
  Effect.runPromise(Effect.provide(e, AppLive(audit)) as Effect.Effect<A, E, never>);

const uid = () => crypto.randomUUID().slice(0, 8);
const Registered = defineEvent("AuditRegistered", {
  schema: Schema.Struct({ userId: Schema.String, email: personal(Schema.String), plan: Schema.String }),
  tags: (d) => ({ user_id: d.userId })
});
const registerCommand = (name: string) =>
  defineCommand({
    name,
    input: Schema.Struct({ userId: Schema.String, email: personal(Schema.String), plan: Schema.String }),
    idempotentBy: (c) => Registered.where({ user_id: c.userId }),
    decide: (_, c) => emit(Registered(c))
  });

interface AuditRow {
  command_id: string;
  type: string;
  data: any;
  metadata: any;
  transaction_id: string;
}
const rowsFor = (type: string) =>
  run(
    Effect.flatMap(SqlClient.SqlClient, (sql) =>
      sql.unsafe<AuditRow>("SELECT command_id::text, type, data, metadata, transaction_id::text FROM crablet_commands WHERE type = $1 ORDER BY occurred_at", [type])
    )
  );

describe("command audit", () => {
  it("a created command leaves one row: personal input redacted, the rest kept, in the SAME transaction as its events", async () => {
    const name = `register-${uid()}`;
    const cmd = registerCommand(name);
    const userId = `u-${uid()}`;
    await run(Effect.flatMap(CommandExecutor, (e) => e.run(cmd, { userId, email: "ann@example.com", plan: "pro" })));

    const rows = await rowsFor(name);
    assert.equal(rows.length, 1);
    assert.deepEqual(rows[0]!.data, { userId, email: "[redacted]", plan: "pro" });
    assert.match(rows[0]!.command_id, /^[0-9a-f-]{36}$/);

    // the row's transaction_id is the transaction that wrote the command's event
    const linked = await run(
      Effect.flatMap(SqlClient.SqlClient, (sql) =>
        sql.unsafe<{ type: string }>(
          "SELECT e.type FROM crablet_commands c JOIN crablet_events e ON e.transaction_id = c.transaction_id WHERE c.command_id = $1::uuid",
          [rows[0]!.command_id]
        )
      )
    );
    assert.deepEqual(linked.map((r) => r.type), ["AuditRegistered"]);
  });

  it("payload modes: none keeps no input, full keeps everything (explicit opt-in), off writes no row", async () => {
    for (const mode of ["none", "full"] as const) {
      const name = `mode-${mode}-${uid()}`;
      const input = { userId: `u-${uid()}`, email: "ann@example.com", plan: "pro" }; // a fresh user per mode: a repeat would record nothing
      await run(Effect.flatMap(CommandExecutor, (e) => e.run(registerCommand(name), input)).pipe(Effect.provideService(AuditConfigRef, { payload: mode })));
      const rows = await rowsFor(name);
      assert.equal(rows.length, 1, mode);
      assert.deepEqual(rows[0]!.data, mode === "none" ? {} : input, mode);
    }
    const offName = `mode-off-${uid()}`;
    await run(Effect.flatMap(CommandExecutor, (e) => e.run(registerCommand(offName), { userId: `u-${uid()}`, email: "a@b.c", plan: "x" })), { payload: "off" });
    assert.equal((await rowsFor(offName)).length, 0);
  });

  it("a repeat that appended nothing, and a refused command, leave no row", async () => {
    class Nope extends DomainError("AuditNope", { fields: {}, kind: "invalid" }) {}
    const name = `repeat-${uid()}`;
    const cmd = registerCommand(name);
    const input = { userId: `u-${uid()}`, email: "a@b.c", plan: "x" };
    await run(
      Effect.gen(function* () {
        const executor = yield* CommandExecutor;
        yield* executor.run(cmd, input);
        const again = yield* executor.run(cmd, input);
        assert.equal(again.wasIdempotent, true);
      })
    );
    assert.equal((await rowsFor(name)).length, 1, "only the first run recorded");

    const refuseName = `refuse-${uid()}`;
    const refuse = defineCommand({ name: refuseName, errors: [Nope], input: Schema.Struct({ id: Schema.String }), decide: () => fail(new Nope()) });
    await run(Effect.flatMap(CommandExecutor, (e) => Effect.exit(e.run(refuse, { id: "x" }))));
    assert.equal((await rowsFor(refuseName)).length, 0);
  });

  it("two commands racing for one seat: the retried loser leaves no row - exactly one row, for the winner", async () => {
    class Taken extends DomainError("AuditSeatTaken", { fields: {}, kind: "conflict" }) {}
    const Booked = defineEvent("AuditSeatBooked", { schema: Schema.Struct({ seatId: Schema.String, guest: personal(Schema.String) }), tags: (d) => ({ seat_id: d.seatId }) });
    const SeatModel = defineModel({ by: "seat_id", initial: () => ({ taken: false }) }).on(Booked, () => ({ taken: true }));
    const name = `book-${uid()}`;
    const seatId = `s-${uid()}`;
    const exits = await run(
      Effect.gen(function* () {
        const wait = yield* barrier(2);
        const book = defineCommand({
          name,
          errors: [Taken],
          input: Schema.Struct({ seatId: Schema.String, guest: personal(Schema.String) }),
          model: (c) => afterLoad(SeatModel.of({ id: c.seatId }), wait),
          decide: (seat, c) => (seat.taken ? fail(new Taken()) : emit(Booked(c)))
        });
        const executor = yield* CommandExecutor;
        return yield* Effect.all([Effect.exit(executor.run(book, { seatId, guest: "ann" })), Effect.exit(executor.run(book, { seatId, guest: "bob" }))], { concurrency: 2 });
      })
    );
    assert.equal(exits.filter((e) => e._tag === "Success").length, 1);
    const rows = await rowsFor(name);
    assert.equal(rows.length, 1, "the failed attempts (the stale first try, then the refusal) wrote nothing");
    assert.equal(rows[0]!.data.guest, "[redacted]");
  });

  it("the correlation id and an app-supplied actor are recorded in the metadata (null when absent)", async () => {
    const plain = `meta-plain-${uid()}`;
    await run(Effect.flatMap(CommandExecutor, (e) => e.run(registerCommand(plain), { userId: `u-${uid()}`, email: "a@b.c", plan: "x" })));
    assert.deepEqual((await rowsFor(plain))[0]!.metadata, { correlationId: null, actor: null });

    const named = `meta-named-${uid()}`;
    const correlation = crypto.randomUUID();
    await run(
      Effect.flatMap(CommandExecutor, (e) => e.run(registerCommand(named), { userId: `u-${uid()}`, email: "a@b.c", plan: "x" })).pipe(
        withActor("user-7"),
        CorrelationContext.withCorrelationId(correlation)
      )
    );
    assert.deepEqual((await rowsFor(named))[0]!.metadata, { correlationId: correlation, actor: "user-7" });
  });

  it("retention: purge deletes only rows older than the window; the periodic helper does the same on a timer", async () => {
    const oldName = `old-${uid()}`;
    const newName = `new-${uid()}`;
    await run(
      Effect.gen(function* () {
        const executor = yield* CommandExecutor;
        yield* executor.run(registerCommand(oldName), { userId: `u-${uid()}`, email: "a@b.c", plan: "x" });
        yield* executor.run(registerCommand(newName), { userId: `u-${uid()}`, email: "a@b.c", plan: "x" });
        const sql = yield* SqlClient.SqlClient;
        yield* sql.unsafe("UPDATE crablet_commands SET occurred_at = now() - interval '40 days' WHERE type = $1", [oldName]);
        const deleted = yield* purgeCommandAudit({ olderThan: "30 days" });
        assert.ok(deleted >= 1);
      })
    );
    assert.equal((await rowsFor(oldName)).length, 0, "the old row was purged");
    assert.equal((await rowsFor(newName)).length, 1, "the recent row stayed");

    // the periodic helper
    const timerName = `timer-${uid()}`;
    await run(
      Effect.gen(function* () {
        const executor = yield* CommandExecutor;
        yield* executor.run(registerCommand(timerName), { userId: `u-${uid()}`, email: "a@b.c", plan: "x" });
        const sql = yield* SqlClient.SqlClient;
        yield* sql.unsafe("UPDATE crablet_commands SET occurred_at = now() - interval '40 days' WHERE type = $1", [timerName]);
        const fiber = yield* startAuditRetention({ olderThan: Duration.days(30), every: Duration.millis(50) });
        for (let i = 0; i < 40; i++) {
          const rows = yield* sql.unsafe("SELECT 1 FROM crablet_commands WHERE type = $1", [timerName]);
          if (rows.length === 0) break;
          yield* Effect.sleep(Duration.millis(50));
        }
        yield* Fiber.interrupt(fiber);
      })
    );
    assert.equal((await rowsFor(timerName)).length, 0, "the timer purged it");
  });
});
