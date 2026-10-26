// Deadlines (Deadline.ts, ADR-0043) in memory: `deadline(...)` in a decision, and `Scenario.fireDue` firing what is due at the scenario's clock.
import { describe, expect, test } from "bun:test";
import { DateTime } from "effect";
import * as Schema from "effect/Schema";
import { byModel, deadline, defineCommand, defineEvent, defineModel, DomainError, emit, fail, Instant, noop, personal } from "../src/Domain.ts";
import { checkDeadlineCommands, DeadlineFired, DeadlineScheduled } from "../src/Deadline.ts";
import { formatMarker } from "@crablet/eventstore/Marker";
import { given } from "../src/testing/Scenario.ts";

const Held = defineEvent("DlHeld", { schema: Schema.Struct({ seatId: Schema.String, heldAt: Instant }), tags: (d) => ({ seat_id: d.seatId }) });
const Released = defineEvent("DlReleased", { schema: Schema.Struct({ seatId: Schema.String }), tags: (d) => ({ seat_id: d.seatId }) });
const Bought = defineEvent("DlBought", { schema: Schema.Struct({ seatId: Schema.String }), tags: (d) => ({ seat_id: d.seatId }) });

const Seat = defineModel({ by: "seat_id", initial: () => ({ status: "never_held" as "never_held" | "held" | "released" | "bought" }) })
  .on(Held, () => ({ status: "held" as const }))
  .on(Released, () => ({ status: "released" as const }))
  .on(Bought, () => ({ status: "bought" as const }));

class NeverHeld extends DomainError("DlNeverHeld", { fields: { seatId: Schema.String }, kind: "not_found" }) {}

// What the deadline runs: gives the seat back unless it was bought. `heldUntil` is in the input, so a deadline knows which hold it was set for.
const ReleaseSeat = defineCommand({
  name: "dl_release_seat",
  input: Schema.Struct({ seatId: Schema.String, heldUntil: Instant }),
  errors: [NeverHeld],
  model: (c) => Seat.of({ id: c.seatId }),
  idempotentBy: byModel(),
  decide: (s, c) =>
    s.status === "bought"
      ? noop("BOUGHT")
      : s.status === "released"
        ? noop("ALREADY_RELEASED")
        : s.status === "never_held"
          ? fail(new NeverHeld({ seatId: c.seatId }))
          : emit(Released({ seatId: c.seatId }))
});

const HOLD_MINUTES = 15;
const Hold = defineCommand({
  name: "dl_hold_seat",
  input: Schema.Struct({ seatId: Schema.String }),
  model: (c) => Seat.of({ id: c.seatId }),
  idempotentBy: byModel(),
  decide: (s, c, { now }) => {
    if (s.status === "held" || s.status === "bought") return noop("NOT_FREE");
    const until = DateTime.add(now, { minutes: HOLD_MINUTES });
    return emit(Held({ seatId: c.seatId, heldAt: now }), deadline(ReleaseSeat, { seatId: c.seatId, heldUntil: until }, { at: until }));
  }
});
const Buy = defineCommand({
  name: "dl_buy_seat",
  input: Schema.Struct({ seatId: Schema.String }),
  model: (c) => Seat.of({ id: c.seatId }),
  idempotentBy: byModel(),
  decide: (s, c) => (s.status === "bought" ? noop("ALREADY_BOUGHT") : emit(Bought(c)))
});

const t0 = DateTime.makeUnsafe("2026-11-02T09:00:00.000Z");
const later = (minutes: number) => DateTime.add(t0, { minutes });

describe("deadline(...): set with the decision", () => {
  test("it is a crablet.DeadlineScheduled with no tags, its input encoded by the command's schema", async () => {
    const r = await given().at(t0).when(Hold, { seatId: "s1" });
    expect(r.events.map((e) => e.type)).toEqual(["DlHeld", "crablet.DeadlineScheduled"]);
    const scheduled = r.events[1]!;
    expect(scheduled.tags).toEqual([]);
    expect(scheduled.data).toEqual({ command: "dl_release_seat", input: { seatId: "s1", heldUntil: "2026-11-02T09:15:00.000Z" }, dueAt: "2026-11-02T09:15:00.000Z" });
    expect(DateTime.toEpochMillis(DeadlineScheduled.decode(scheduled.data).dueAt)).toBe(DateTime.toEpochMillis(later(HOLD_MINUTES)));
  });

  test("a command that cannot recognise a repeat, or whose input has personal data, is refused where the deadline is built", () => {
    const NoKey = defineCommand({ name: "dl_no_key", input: Schema.Struct({ id: Schema.String }), decide: () => noop("X") });
    const Personal = defineCommand({ name: "dl_personal", input: Schema.Struct({ id: Schema.String, email: personal(Schema.String) }), idempotentBy: (c) => Released.where({ seat_id: c.id }), decide: () => noop("X") });
    expect(() => deadline(NoKey, { id: "a" }, { at: t0 })).toThrow(/dl_no_key.*no idempotentBy/);
    expect(() => deadline(Personal, { id: "a", email: "a@b.c" }, { at: t0 })).toThrow(/dl_personal.*personal/);
    expect(() => checkDeadlineCommands([NoKey])).toThrow(/no idempotentBy/);
    expect(() => checkDeadlineCommands([ReleaseSeat, ReleaseSeat])).toThrow(/given twice/);
  });
});

describe("Scenario.fireDue: what the deadlines processor does, at the scenario's clock", () => {
  test("nothing fires before the due time; at it, the command runs under the deadline as its cause, and the firing is recorded", async () => {
    const s = given();
    await s.at(t0).when(Hold, { seatId: "s1" });
    expect(await s.at(later(HOLD_MINUTES - 1)).fireDue(ReleaseSeat)).toEqual([]);

    const [fired] = await s.at(later(HOLD_MINUTES)).fireDue(ReleaseSeat);
    const deadlinePosition = s.log.find((e) => e.type === "crablet.DeadlineScheduled")!.position;
    const released = fired!.events.at(-1)!;
    const marker = formatMarker({ transactionId: released.transactionId, position: released.position });
    expect(fired).toMatchObject({ deadlinePosition, command: "dl_release_seat", outcome: "appended", reason: null, marker });
    expect(fired!.events.map((e) => [e.type, e.causationId])).toEqual([["DlReleased", deadlinePosition]]);
    const record = s.log.at(-1)!;
    expect([record.type, record.causationId, record.tags]).toEqual([DeadlineFired.type, deadlinePosition, []]);
    // The marker: where the command's write ended, to wait on a view that shows it.
    expect(record.data).toEqual({ deadlinePosition: deadlinePosition.toString(), outcome: "appended", reason: null, marker });
  });

  test("a deadline fires once: a second fireDue finds nothing", async () => {
    const s = given();
    await s.at(t0).when(Hold, { seatId: "s1" });
    expect((await s.at(later(60)).fireDue(ReleaseSeat)).length).toBe(1);
    expect(await s.at(later(120)).fireDue(ReleaseSeat)).toEqual([]);
  });

  test("a deadline that no longer matters is a noop with its reason; a domain error is a decision, recorded as failed", async () => {
    const s = given();
    await s.at(t0).when(Hold, { seatId: "bought" });
    await s.at(later(1)).when(Buy, { seatId: "bought" });
    expect(await s.at(later(2)).fireDue(ReleaseSeat)).toEqual([]); // nothing due yet
    const bought = s.log.at(-1)!;
    expect((await s.at(later(HOLD_MINUTES)).fireDue(ReleaseSeat)).map((f) => [f.outcome, f.reason, f.marker])).toEqual([
      ["noop", "BOUGHT", formatMarker({ transactionId: bought.transactionId, position: bought.position })]
    ]);
    // A deadline whose command answers with a domain error (the seat was never held): that is its outcome, and it is done.
    const ghost = given(deadline(ReleaseSeat, { seatId: "ghost", heldUntil: t0 }, { at: t0 }));
    expect((await ghost.at(later(1)).fireDue(ReleaseSeat)).map((f) => [f.outcome, f.reason, f.marker])).toEqual([["failed", "DlNeverHeld", null]]);
    expect(await ghost.at(later(2)).fireDue(ReleaseSeat)).toEqual([]);
  });

  test("due deadlines fire oldest due first", async () => {
    const s = given();
    await s.at(later(5)).when(Hold, { seatId: "b" });
    await s.at(t0).when(Hold, { seatId: "a" });
    const fired = await s.at(later(60)).fireDue(ReleaseSeat);
    expect(fired.map((f) => (f.events[0]!.data as { seatId: string }).seatId)).toEqual(["a", "b"]);
  });

  test("a deadline whose command is not given throws, naming it", async () => {
    const s = given();
    await s.at(t0).when(Hold, { seatId: "s1" });
    await expect(s.at(later(60)).fireDue(Buy)).rejects.toThrow(/dl_release_seat.*not among the commands/);
  });
});
