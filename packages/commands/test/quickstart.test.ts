// The README's quick start, as a test: if this stops compiling or passing, the README is lying.
// Keep the two in sync (the code between the START/END markers is what the README shows).
import { describe, expect, test } from "bun:test";
import { Schema } from "effect";
import { defineEvent } from "../src/Event.ts";
import { defineModel } from "../src/Model.ts";
import { defineCommand, emit, fail } from "../src/Command.ts";
import { DomainError } from "../src/Errors.ts";
import { given } from "../src/testing/Scenario.ts";

// ---- START README ----
// 1. An event: its name, its payload, and the tags it can be found by.
const SeatBooked = defineEvent("SeatBooked", {
  schema: Schema.Struct({ seatId: Schema.String, guest: Schema.String }),
  tags: (d) => ({ seat_id: d.seatId })
});

// 2. A model: what the events mean for one seat - and, from the same declaration, which events
//    could change that answer (the command's consistency boundary).
const SeatModel = defineModel({ by: "seat_id", initial: () => ({ taken: false }) })
  .on(SeatBooked, () => ({ taken: true }));

class SeatTaken extends DomainError("SeatTaken", {
  fields: { seatId: Schema.String },
  kind: "conflict"
}) {}

// 3. A command: a pure decision. Nothing here touches a database.
const BookSeat = defineCommand({
  name: "book_seat",
  errors: [SeatTaken],      // the domain errors it can fail with: checked against `decide`, read by the REST API
  input: Schema.Struct({ seatId: Schema.String, guest: Schema.String }),
  model: (c) => SeatModel.of({ id: c.seatId }),
  decide: (seat, c) => (seat.taken ? fail(new SeatTaken({ seatId: c.seatId })) : emit(SeatBooked(c)))
});
// ---- END README ----

describe("README quick start", () => {
  test("testing it: given a history, when a command arrives, then ...", async () => {
    const scenario = given();

    const first = await scenario.when(BookSeat, { seatId: "12A", guest: "Ann" });
    expect(first.outcome).toBe("created");
    expect(first.events.map((e) => e.type)).toEqual(["SeatBooked"]);

    const second = await scenario.when(BookSeat, { seatId: "12A", guest: "Bob" });
    expect(second.error).toBeInstanceOf(SeatTaken);

    // another seat is unaffected
    expect((await scenario.when(BookSeat, { seatId: "12B", guest: "Bob" })).outcome).toBe("created");
  });

  test("the Schema import used in the README is the one from the effect barrel", () => {
    expect(typeof Schema.Struct).toBe("function");
  });
});
