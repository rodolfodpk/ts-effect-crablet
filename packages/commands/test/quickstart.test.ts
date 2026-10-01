// The README's quick start, as a test: if this stops compiling or passing, the README is lying.
// Keep the two in sync (the code between the START/END markers is what the README shows).
import { describe, expect, test } from "bun:test";
import { Schema } from "effect";
import { defineEvent } from "../src/Event.ts";
import { defineModel } from "../src/Model.ts";
import { defineCommand, emit, fail, noop } from "../src/Command.ts";
import { DomainError } from "../src/Errors.ts";
import { given } from "../src/testing/Scenario.ts";

// ---- START README ----
// 1. Events: their names, their payloads, and the tags they can be found by.
const SeatAdded = defineEvent("SeatAdded", {
  schema: Schema.Struct({ seatId: Schema.String }),
  tags: (d) => ({ seat_id: d.seatId })
});
const SeatBooked = defineEvent("SeatBooked", {
  schema: Schema.Struct({ seatId: Schema.String, guest: Schema.String }),
  tags: (d) => ({ seat_id: d.seatId })
});

// 2. A model: what the events mean for one seat - and, from the same declaration, which events
//    could change that answer (the command's consistency boundary).
const SeatModel = defineModel({ by: "seat_id", initial: () => ({ exists: false, taken: false }) })
  .on(SeatAdded, (seat) => ({ ...seat, exists: true }))
  .on(SeatBooked, (seat) => ({ ...seat, taken: true }));

class SeatNotFound extends DomainError("SeatNotFound", {
  fields: { seatId: Schema.String },
  kind: "not_found"
}) {}
class SeatTaken extends DomainError("SeatTaken", {
  fields: { seatId: Schema.String },
  kind: "conflict"
}) {}

// 3. Commands: pure decisions. Nothing here touches a database.
const AddSeat = defineCommand({
  name: "add_seat",
  errors: [],
  input: Schema.Struct({ seatId: Schema.String }),
  model: (c) => SeatModel.of({ id: c.seatId }),
  decide: (seat, c) => (seat.exists ? noop("already added") : emit(SeatAdded(c)))
});

const BookSeat = defineCommand({
  name: "book_seat",
  errors: [SeatNotFound, SeatTaken],      // the domain errors it can fail with: checked against `decide`, read by the REST API
  input: Schema.Struct({ seatId: Schema.String, guest: Schema.String }),
  model: (c) => SeatModel.of({ id: c.seatId }),
  decide: (seat, c) =>
    !seat.exists
      ? fail(new SeatNotFound({ seatId: c.seatId }))
      : seat.taken
        ? fail(new SeatTaken({ seatId: c.seatId }))
        : emit(SeatBooked(c))
});
// ---- END README ----

describe("README quick start", () => {
  test("testing it: given a history, when a command arrives, then ...", async () => {
    const scenario = given();
    expect((await scenario.when(AddSeat, { seatId: "12A" })).outcome).toBe("created");
    expect((await scenario.when(AddSeat, { seatId: "12A" })).outcome).toBe("idempotent");

    const first = await scenario.when(BookSeat, { seatId: "12A", guest: "Ann" });
    expect(first.outcome).toBe("created");
    expect(first.events.map((e) => e.type)).toEqual(["SeatBooked"]);

    const second = await scenario.when(BookSeat, { seatId: "12A", guest: "Bob" });
    expect(second.error).toBeInstanceOf(SeatTaken);

    // a seat that was never added does not exist
    expect((await scenario.when(BookSeat, { seatId: "99Z", guest: "Bob" })).error).toBeInstanceOf(SeatNotFound);

    // another seat is unaffected
    await scenario.when(AddSeat, { seatId: "12B" });
    expect((await scenario.when(BookSeat, { seatId: "12B", guest: "Bob" })).outcome).toBe("created");
  });

  test("the Schema import used in the README is the one from the effect barrel", () => {
    expect(typeof Schema.Struct).toBe("function");
  });
});
