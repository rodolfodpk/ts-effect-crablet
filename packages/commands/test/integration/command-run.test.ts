// Runs under Node (Testcontainers). `CommandExecutor.run` with defined commands against real
// Postgres: conflict retry, idempotency and input validation. Races are made deterministic with a
// barrier AFTER the model has loaded, so that BOTH commands load before EITHER appends (no timing luck).
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { Deferred, Effect, Layer, Metric, Redacted, Ref } from "effect";
import * as Schema from "effect/Schema";
import { SqlClient } from "effect/sql";
import { PgClient } from "@effect/sql-pg";
import { startTestDb, type TestDb } from "@crablet/test-support";
import { EventStore, EventStoreLive } from "@crablet/eventstore";
import { CommandAuditStore, CommandAuditStoreLive } from "@crablet/eventstore/CommandAuditStore";
import { Conflict, Duplicate } from "@crablet/eventstore/AppendErrors";
import * as LogPosition from "@crablet/eventstore/LogPosition";
import * as CommandMetrics from "@crablet/metrics-otel/CommandMetrics";
import { CommandExecutor, CommandExecutorLive } from "../../src/CommandExecutor.ts";
import { concurrent, defineCommand, emit, fail } from "../../src/Command.ts";
import { DomainError, InvalidInput } from "../../src/Errors.ts";
import { defineEvent } from "../../src/Event.ts";
import { defineModel } from "../../src/Model.ts";
import { afterLoad } from "../support/barrier.ts";

let db: TestDb;
let layer: Layer.Layer<CommandExecutor | EventStore | CommandAuditStore | SqlClient.SqlClient, never>;

before(async () => {
  db = await startTestDb();
  const pgLayer = PgClient.layer({
    host: db.connInfo.host,
    port: db.connInfo.port,
    database: db.connInfo.database,
    username: db.connInfo.username,
    password: Redacted.make(db.connInfo.password)
  });
  const appLayers = Layer.mergeAll(CommandExecutorLive, EventStoreLive, CommandAuditStoreLive);
  layer = Layer.provideMerge(appLayers, pgLayer) as unknown as Layer.Layer<
    CommandExecutor | EventStore | CommandAuditStore | SqlClient.SqlClient,
    never
  >;
}, { timeout: 60_000 });

after(async () => {
  await db.stop();
});

const run = <A, E>(effect: Effect.Effect<A, E, CommandExecutor | EventStore | CommandAuditStore | SqlClient.SqlClient>) =>
  Effect.runPromise(Effect.provide(effect, layer) as Effect.Effect<A, E, never>);

// ---- a small domain: booking seats (one booking per seat) ----
const SeatBooked = defineEvent("SeatBooked", {
  schema: Schema.Struct({ seatId: Schema.String, guest: Schema.String, bookingId: Schema.String }),
  tags: (d) => ({ seat_id: d.seatId, booking_id: d.bookingId })
});
const SeatModel = defineModel({ by: "seat_id", initial: () => ({ taken: false }) }).on(SeatBooked, () => ({ taken: true }));
class SeatTaken extends DomainError("SeatTaken", { fields: { seatId: Schema.String }, kind: "conflict" }) {}

const bookingInput = Schema.Struct({ seatId: Schema.String, guest: Schema.String, bookingId: Schema.String });

// Waits until `parties` callers have arrived, then releases them all together. Already-open on later passes.
const makeBarrier = (parties: number) =>
  Effect.gen(function* () {
    const arrived = yield* Ref.make(0);
    const gate = yield* Deferred.make<void>();
    return {
      wait: Effect.gen(function* () {
        const n = yield* Ref.updateAndGet(arrived, (x) => x + 1);
        if (n >= parties) yield* Deferred.succeed(gate, undefined);
        yield* Deferred.await(gate);
      })
    };
  });

type Barrier = { readonly wait: Effect.Effect<void> };

const bookSeat = (opts: { barrier?: Barrier; retries?: number; idempotent?: "return" | "fail" } = {}) =>
  defineCommand({
    name: "book_seat",
    errors: [SeatTaken],
    input: bookingInput,
    model: (c) => (opts.barrier ? afterLoad(SeatModel.of({ id: c.seatId }), opts.barrier.wait) : SeatModel.of({ id: c.seatId })),
    ...(opts.idempotent !== undefined
      ? { idempotentBy: (c: { bookingId: string }) => SeatBooked.where({ booking_id: c.bookingId }), onDuplicate: opts.idempotent }
      : {}),
    retries: opts.retries ?? 3,
    decide: (seat, c) => (seat.taken ? fail(new SeatTaken({ seatId: c.seatId })) : emit(SeatBooked(c)))
  });

const uid = () => crypto.randomUUID();
const seat = () => `seat-${uid()}`;
const booking = (seatId: string, guest = "g") => ({ seatId, guest, bookingId: uid() });

const eventsOnSeat = (seatId: string) =>
  run(
    Effect.flatMap(EventStore, (es) =>
      Effect.map(
        es.project(SeatBooked.where({ seat_id: seatId }), LogPosition.zero(), [
          { eventTypes: [], initialState: 0, transition: (n: number) => n + 1 }
        ]),
        (r) => r.state
      )
    )
  );

const exitsOf = <A, E>(effects: ReadonlyArray<Effect.Effect<A, E, any>>) =>
  run(Effect.all(effects.map((e) => Effect.exit(e)), { concurrency: effects.length }) as Effect.Effect<any, never, any>) as Promise<
    ReadonlyArray<{ _tag: "Success"; value: A } | { _tag: "Failure"; cause: { reasons: ReadonlyArray<{ _tag: string; error?: unknown }> } }>
  >;
const failureOf = (exit: any) => exit.cause.reasons.find((r: any) => r._tag === "Fail")?.error;

describe("CommandExecutor.run: conflict retry", () => {
  it("two concurrent bookings of the SAME seat: one wins; the loser is retried, re-decides, and fails with the DOMAIN error (not a Conflict)", async () => {
    const s = seat();
    const barrier = await run(makeBarrier(2));
    const cmd = bookSeat({ barrier });
    const exits = await exitsOf([
      Effect.flatMap(CommandExecutor, (e) => e.run(cmd, booking(s, "ann"))),
      Effect.flatMap(CommandExecutor, (e) => e.run(cmd, booking(s, "bob")))
    ]);
    const wins = exits.filter((e) => e._tag === "Success");
    const losses = exits.filter((e) => e._tag === "Failure");
    assert.equal(wins.length, 1, "exactly one booking wins");
    assert.equal(losses.length, 1);
    assert.ok(failureOf(losses[0]) instanceof SeatTaken, `loser should fail with SeatTaken, got ${JSON.stringify(failureOf(losses[0]))}`);
    assert.equal(await eventsOnSeat(s), 1, "the seat was booked exactly once");

    // the retry was counted
    const retried = await run(Metric.value(Metric.withAttributes(CommandMetrics.conflictRetries, { command_type: "book_seat" })));
    assert.ok(retried.count >= 1, `expected a recorded conflict retry, got ${retried.count}`);
  });

  it("with retries: 0 the loser surfaces the Conflict itself", async () => {
    const s = seat();
    const barrier = await run(makeBarrier(2));
    const cmd = bookSeat({ barrier, retries: 0 });
    const exits = await exitsOf([
      Effect.flatMap(CommandExecutor, (e) => e.run(cmd, booking(s))),
      Effect.flatMap(CommandExecutor, (e) => e.run(cmd, booking(s)))
    ]);
    assert.equal(exits.filter((e) => e._tag === "Success").length, 1);
    const loser = exits.find((e) => e._tag === "Failure");
    const error = failureOf(loser);
    assert.ok(error instanceof Conflict, `expected Conflict, got ${JSON.stringify(error)}`);
    assert.equal(error.kind, "boundary");
    assert.equal(await eventsOnSeat(s), 1);
  });

  it("bookings of DIFFERENT seats never conflict, even fully concurrent", async () => {
    const barrier = await run(makeBarrier(2));
    const cmd = bookSeat({ barrier, retries: 0 });
    const a = seat();
    const b = seat();
    const exits = await exitsOf([
      Effect.flatMap(CommandExecutor, (e) => e.run(cmd, booking(a))),
      Effect.flatMap(CommandExecutor, (e) => e.run(cmd, booking(b)))
    ]);
    assert.deepEqual(exits.map((e) => e._tag), ["Success", "Success"]);
  });
});

describe("CommandExecutor.run: idempotency with strict consistency", () => {
  it("the same booking submitted twice concurrently: one Created, one Idempotent, one event (not a Conflict)", async () => {
    const s = seat();
    const barrier = await run(makeBarrier(2));
    const cmd = bookSeat({ barrier, retries: 0, idempotent: "return" });
    const input = booking(s);
    const exits = await exitsOf([
      Effect.flatMap(CommandExecutor, (e) => e.run(cmd, input)),
      Effect.flatMap(CommandExecutor, (e) => e.run(cmd, input))
    ]);
    const outcomes = exits.map((e) => (e._tag === "Success" ? ((e as any).value.wasIdempotent ? "idempotent" : "created") : "failure")).sort();
    assert.deepEqual(outcomes, ["created", "idempotent"]);
    assert.equal(await eventsOnSeat(s), 1);
  });

  it("a later repeat is an idempotent success, even though the seat is now taken (the check runs before decide)", async () => {
    const s = seat();
    const cmd = bookSeat({ idempotent: "return" });
    const input = booking(s);
    const first = await run(Effect.flatMap(CommandExecutor, (e) => e.run(cmd, input)));
    assert.equal(first.wasIdempotent, false);
    const repeat = await run(Effect.flatMap(CommandExecutor, (e) => e.run(cmd, input)));
    assert.equal(repeat.wasIdempotent, true);
    // a DIFFERENT booking of the taken seat is a genuine domain refusal
    const other = await exitsOf([Effect.flatMap(CommandExecutor, (e) => e.run(cmd, booking(s)))]);
    assert.ok(failureOf(other[0]) instanceof SeatTaken);
  });

  it('onDuplicate "fail": a repeat fails with Duplicate, sequentially and when racing', async () => {
    const s = seat();
    const cmd = bookSeat({ idempotent: "fail" });
    const input = booking(s);
    await run(Effect.flatMap(CommandExecutor, (e) => e.run(cmd, input)));
    const repeat = await exitsOf([Effect.flatMap(CommandExecutor, (e) => e.run(cmd, input))]);
    assert.ok(failureOf(repeat[0]) instanceof Duplicate);

    const s2 = seat();
    const barrier = await run(makeBarrier(2));
    const racing = bookSeat({ barrier, idempotent: "fail", retries: 0 });
    const input2 = booking(s2);
    const exits = await exitsOf([
      Effect.flatMap(CommandExecutor, (e) => e.run(racing, input2)),
      Effect.flatMap(CommandExecutor, (e) => e.run(racing, input2))
    ]);
    assert.equal(exits.filter((e) => e._tag === "Success").length, 1);
    assert.ok(failureOf(exits.find((e) => e._tag === "Failure")) instanceof Duplicate);
  });
});

describe("CommandExecutor.run: input", () => {
  it("run validates untrusted input (InvalidInput); runDecoded trusts already-typed input", async () => {
    const cmd = bookSeat();
    const bad = await exitsOf([Effect.flatMap(CommandExecutor, (e) => e.run(cmd, { seatId: 5 }))]);
    assert.ok(failureOf(bad[0]) instanceof InvalidInput);

    const s = seat();
    const ok = await run(Effect.flatMap(CommandExecutor, (e) => e.runDecoded(cmd, booking(s))));
    assert.equal(ok.wasIdempotent, false);
    assert.equal(await eventsOnSeat(s), 1);
  });
});

// ---- a lifecycle guard: bookings run concurrently, but not once the seat has been closed ----
const SeatClosed = defineEvent("SeatClosed", {
  schema: Schema.Struct({ seatId: Schema.String }),
  tags: (d) => ({ seat_id: d.seatId })
});
const closeSeat = defineCommand({
  name: "close_seat",
  input: Schema.Struct({ seatId: Schema.String }),
  decide: (_, c) => emit(SeatClosed(c))
});

// Like `SeatModel.of`, but holds the command after it has LOADED until `gate` opens - so a test can
// change the world between the load and the append, deterministically.
const heldAfterLoad = (seatId: string, gate: Effect.Effect<void>) => {
  const model = SeatModel.of({ id: seatId });
  return { ...model, load: (es: Parameters<typeof model.load>[0]) => Effect.tap(model.load(es), () => gate) };
};

const guardedBooking = (gate: Effect.Effect<void>, retries = 3) =>
  defineCommand({
    name: "guarded_booking",
    input: bookingInput,
    model: (c) => heldAfterLoad(c.seatId, gate),
    consistency: (c) => concurrent({ guard: SeatClosed.where({ seat_id: c.seatId }) }),
    idempotentBy: (c) => SeatBooked.where({ booking_id: c.bookingId }),
    retries,
    decide: (_, c) => emit(SeatBooked(c))
  });

describe("CommandExecutor.run: lifecycle guard", () => {
  it("a guard event committed between load and append is a guard Conflict; unrelated concurrent bookings are not", async () => {
    const s = seat();
    const gate = await run(Deferred.make<void>());
    const cmd = guardedBooking(Deferred.await(gate), 0);

    const racing = exitsOf([Effect.flatMap(CommandExecutor, (e) => e.run(cmd, booking(s)))]);
    await new Promise((r) => setTimeout(r, 200)); // the booking has loaded and is held
    await run(Effect.flatMap(CommandExecutor, (e) => e.run(closeSeat, { seatId: s })));
    await run(Deferred.succeed(gate, undefined));

    const [exit] = await racing;
    assert.equal(exit!._tag, "Failure");
    const error = failureOf(exit);
    assert.ok(error instanceof Conflict, `expected Conflict, got ${JSON.stringify(error)}`);
    assert.equal(error.kind, "guard");
    assert.equal(await eventsOnSeat(s), 0);

    // another booking of the same seat that is NOT racing a close commits fine, even next to its peers
    const open = seat();
    const openGate = await run(Deferred.make<void>());
    await run(Deferred.succeed(openGate, undefined));
    const peers = await exitsOf([
      Effect.flatMap(CommandExecutor, (e) => e.run(guardedBooking(Deferred.await(openGate), 0), booking(open))),
      Effect.flatMap(CommandExecutor, (e) => e.run(guardedBooking(Deferred.await(openGate), 0), booking(open)))
    ]);
    assert.deepEqual(peers.map((p) => p._tag), ["Success", "Success"]);
  });

  it("guard + idempotency: repeating a done booking after the seat closed is 'already done', not a Conflict", async () => {
    const s = seat();
    const b = booking(s);
    const open = await run(Deferred.make<void>());
    await run(Deferred.succeed(open, undefined));
    const cmd = guardedBooking(Deferred.await(open));

    const first = await run(Effect.flatMap(CommandExecutor, (e) => e.run(cmd, b)));
    assert.equal(first.wasIdempotent, false);
    await run(Effect.flatMap(CommandExecutor, (e) => e.run(closeSeat, { seatId: s })));
    const repeat = await run(Effect.flatMap(CommandExecutor, (e) => e.run(cmd, b)));
    assert.equal(repeat.wasIdempotent, true);
  });
});
