// Runs under Node (Testcontainers). The README quick start (same event, model and command as
// quickstart.test.ts) run for real: `CommandExecutor.run` inside a Postgres transaction.
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { Effect, Redacted } from "effect";
import * as Schema from "effect/Schema";
import { SqlClient } from "effect/sql";
import { startTestDb, type TestDb } from "@crablet/test-support";
import * as Crablet from "../../src/Crablet.ts";
import { CommandExecutor } from "../../src/CommandExecutor.ts";
import { defineCommand, emit, fail } from "../../src/Command.ts";
import { DomainError } from "../../src/Errors.ts";
import { defineEvent } from "../../src/Event.ts";
import { defineModel } from "../../src/Model.ts";

// ---- the README quick start ----
const SeatBooked = defineEvent("SeatBooked", {
  schema: Schema.Struct({ seatId: Schema.String, guest: Schema.String }),
  tags: (d) => ({ seat_id: d.seatId })
});
const SeatModel = defineModel({ by: "seat_id", initial: () => ({ taken: false }) }).on(SeatBooked, () => ({ taken: true }));
class SeatTaken extends DomainError("SeatTaken", { fields: { seatId: Schema.String }, kind: "conflict" }) {}
const BookSeat = defineCommand({
  name: "book_seat",
  input: Schema.Struct({ seatId: Schema.String, guest: Schema.String }),
  model: (c) => SeatModel.of({ id: c.seatId }),
  decide: (seat, c) => (seat.taken ? fail(new SeatTaken({ seatId: c.seatId })) : emit(SeatBooked(c)))
});
// ---- end ----

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

describe("README quick start against Postgres", () => {
  it("books a seat, refuses a second booking, leaves other seats alone, and the events are in the table", async () => {
    const program = Effect.gen(function* () {
      const executor = yield* CommandExecutor;
      const sql = yield* SqlClient.SqlClient;

      const first = yield* executor.run(BookSeat, { seatId: "12A", guest: "Ann" });
      const second = yield* Effect.flip(executor.run(BookSeat, { seatId: "12A", guest: "Bob" }));
      const other = yield* executor.run(BookSeat, { seatId: "12B", guest: "Bob" });
      const rows = yield* sql<{ type: string; tags: string; data: unknown }>`
        SELECT type, tags::text AS tags, data FROM crablet_events ORDER BY position`;
      return { first, second, other, rows };
    });
    const r = await Effect.runPromise(Effect.provide(program, AppLive()));

    console.log("first :", r.first);
    console.log("second:", r.second._tag, JSON.stringify(r.second));
    console.log("other :", r.other);
    console.log("table :", JSON.stringify(r.rows, null, 1));

    assert.equal(r.first.wasIdempotent, false);
    assert.ok(r.second instanceof SeatTaken);
    assert.equal(r.other.wasIdempotent, false);
    assert.equal(r.rows.length, 2);
  });

  it("two guests racing for the SAME free seat: exactly one wins, the other gets SeatTaken", async () => {
    const program = Effect.gen(function* () {
      const executor = yield* CommandExecutor;
      const exits = yield* Effect.all(
        [executor.run(BookSeat, { seatId: "7C", guest: "Ann" }), executor.run(BookSeat, { seatId: "7C", guest: "Bob" })].map(Effect.exit),
        { concurrency: 2 }
      );
      return exits;
    });
    const exits = await Effect.runPromise(Effect.provide(program, AppLive()));
    const wins = exits.filter((e) => e._tag === "Success").length;
    assert.equal(wins, 1);
    const loser = exits.find((e) => e._tag === "Failure") as any;
    assert.ok(loser.cause.reasons.some((x: any) => x.error instanceof SeatTaken));
  });
});
