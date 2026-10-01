// The README's quick start, runnable: `bun run --cwd examples/quickstart start` (or `node src/quickstart.ts`).
// It runs the real command pipeline against the in-memory store - no database needed - and prints what happened.
import { Schema } from "effect";
import { defineEvent } from "@crablet/commands/Event";
import { defineModel } from "@crablet/commands/Model";
import { defineCommand, emit, fail } from "@crablet/commands/Command";
import { DomainError } from "@crablet/commands/Errors";
import { given } from "@crablet/commands/testing/Scenario";

// ---- START README ----
// 1. An event: its name, its payload, and the tags it can be found by.
export const SeatBooked = defineEvent("SeatBooked", {
  schema: Schema.Struct({ seatId: Schema.String, guest: Schema.String }),
  tags: (d) => ({ seat_id: d.seatId })
});

// 2. A model: what the events mean for one seat - and, from the same declaration, which events
//    could change that answer (the command's consistency boundary).
export const SeatModel = defineModel({ by: "seat_id", initial: () => ({ taken: false }) })
  .on(SeatBooked, () => ({ taken: true }));

export class SeatTaken extends DomainError("SeatTaken", {
  fields: { seatId: Schema.String },
  kind: "conflict"
}) {}

// 3. A command: a pure decision. Nothing here touches a database.
export const BookSeat = defineCommand({
  name: "book_seat",
  errors: [SeatTaken],      // the domain errors it can fail with: checked against `decide`, read by the REST API
  input: Schema.Struct({ seatId: Schema.String, guest: Schema.String }),
  model: (c) => SeatModel.of({ id: c.seatId }),
  decide: (seat, c) => (seat.taken ? fail(new SeatTaken({ seatId: c.seatId })) : emit(SeatBooked(c)))
});
// ---- END README ----

/** Runs the scenario and returns the lines it prints (so the test can pin them). */
export const run = async (): Promise<ReadonlyArray<string>> => {
  const scenario = given();                                                        // an empty history
  const first = await scenario.when(BookSeat, { seatId: "12A", guest: "Ann" });
  const second = await scenario.when(BookSeat, { seatId: "12A", guest: "Bob" });
  const third = await scenario.when(BookSeat, { seatId: "12B", guest: "Bob" });
  // The same thing with the history written out: the executor loads the events in the model's boundary
  // (SeatBooked tagged seat_id=12A), folds them into `{ taken: true }`, and only then calls `decide`.
  const seeded = await given(SeatBooked({ seatId: "12A", guest: "Ann" })).when(BookSeat, { seatId: "12A", guest: "Cy" });
  const show = (r: typeof first) =>
    r.error ? `failed: ${r.error._tag}` : `${r.outcome}: ${r.events.map((e) => e.type).join(", ")}`;
  return [
    `12A for Ann -> ${show(first)}`,
    `12A for Bob -> ${show(second)}`,
    `12B for Bob -> ${show(third)}`,
    `12A for Cy, after a SeatBooked in the history -> ${show(seeded)}`
  ];
};

if (import.meta.main) {
  for (const line of await run()) console.log(line);
}
