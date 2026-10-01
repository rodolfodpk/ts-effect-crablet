// The README's quick start, runnable: `bun run --cwd examples/quickstart start` (or `node src/quickstart.ts`).
// It runs the real command pipeline against the in-memory store - no database needed - and prints what happened.
import { Schema } from "effect";
import { defineEvent } from "@crablet/commands/Event";
import { defineModel } from "@crablet/commands/Model";
import { defineCommand, emit, fail, noop } from "@crablet/commands/Command";
import { DomainError } from "@crablet/commands/Errors";
import { given } from "@crablet/commands/testing/Scenario";

// ---- START README ----
// 1. Events: their names, their payloads, and the tags they can be found by.
export const SeatAdded = defineEvent("SeatAdded", {
  schema: Schema.Struct({ seatId: Schema.String }),
  tags: (d) => ({ seat_id: d.seatId })
});
export const SeatBooked = defineEvent("SeatBooked", {
  schema: Schema.Struct({ seatId: Schema.String, guest: Schema.String }),
  tags: (d) => ({ seat_id: d.seatId })
});

// 2. A model: what the events mean for one seat - and, from the same declaration, which events
//    could change that answer (the command's consistency boundary).
export const SeatModel = defineModel({ by: "seat_id", initial: () => ({ exists: false, taken: false }) })
  .on(SeatAdded, (seat) => ({ ...seat, exists: true }))
  .on(SeatBooked, (seat) => ({ ...seat, taken: true }));

export class SeatNotFound extends DomainError("SeatNotFound", {
  fields: { seatId: Schema.String },
  kind: "not_found"
}) {}
export class SeatTaken extends DomainError("SeatTaken", {
  fields: { seatId: Schema.String },
  kind: "conflict"
}) {}

// 3. Commands: pure decisions. Nothing here touches a database.
export const AddSeat = defineCommand({
  name: "add_seat",
  errors: [],
  input: Schema.Struct({ seatId: Schema.String }),
  model: (c) => SeatModel.of({ id: c.seatId }),
  decide: (seat, c) => (seat.exists ? noop("already added") : emit(SeatAdded(c)))
});

export const BookSeat = defineCommand({
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

/** Runs the scenario and returns the lines it prints (so the test can pin them). */
export const run = async (): Promise<ReadonlyArray<string>> => {
  const scenario = given();                                                        // an empty history
  const lines: Array<string> = [];
  const show = (r: { outcome: string; events: ReadonlyArray<{ type: string }>; error?: { _tag: string } | undefined }) =>
    r.error ? `failed: ${r.error._tag}` : `${r.outcome}: ${r.events.map((e) => e.type).join(", ") || "nothing appended"}`;
  const step = async <I>(label: string, s: { when: (...a: any[]) => Promise<any> }, command: unknown, input: I) =>
    lines.push(`${label} -> ${show(await s.when(command, input))}`);

  await step("add 12A           ", scenario, AddSeat, { seatId: "12A" });
  await step("add 12A again     ", scenario, AddSeat, { seatId: "12A" });
  await step("book 12A for Ann  ", scenario, BookSeat, { seatId: "12A", guest: "Ann" });
  await step("book 12A for Bob  ", scenario, BookSeat, { seatId: "12A", guest: "Bob" });
  await step("book 99Z for Bob  ", scenario, BookSeat, { seatId: "99Z", guest: "Bob" });

  // The same thing with the history written out: the executor loads the events in the model's boundary
  // (SeatAdded and SeatBooked tagged seat_id=12A), folds them into `{ exists: true, taken: true }`, and only then calls `decide`.
  const seeded = given(SeatAdded({ seatId: "12A" }), SeatBooked({ seatId: "12A", guest: "Ann" }));
  await step("book 12A for Cy, history: SeatAdded + SeatBooked", seeded, BookSeat, { seatId: "12A", guest: "Cy" });
  return lines;
};

if (import.meta.main) {
  for (const line of await run()) console.log(line);
}
