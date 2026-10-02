// Compile-time tests (never executed): a contract keeps its literal types, and a command built from it by spreading is EXACTLY the
// command type of a direct declaration, with the same checks.
import * as Schema from "effect/Schema";
import { defineCommand, emit, fail } from "../src/Command.ts";
import type { Command } from "../src/Command.ts";
import { commandContract } from "../src/Contract.ts";
import { DomainError } from "../src/Errors.ts";
import { defineEvent } from "../src/Event.ts";

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Expect<T extends true> = T;

class SeatTaken extends DomainError("SeatTaken", { fields: { seatId: Schema.String }, kind: "conflict" }) {}
class NoSuchSeat extends DomainError("NoSuchSeat", { fields: { seatId: Schema.String }, kind: "not_found" }) {}
const SeatBooked = defineEvent("SeatBooked", { schema: Schema.Struct({ seatId: Schema.String }), tags: (d) => ({ seat_id: d.seatId }) });
const Input = Schema.Struct({ seatId: Schema.String, row: Schema.Int });

const BookContract = commandContract({ name: "book", input: Input, errors: [SeatTaken, NoSuchSeat] });
const LogContract = commandContract({ name: "log", input: Input });

export type KeepsTheName = Expect<Equal<(typeof BookContract)["name"], "book">>;
export type KeepsTheInput = Expect<Equal<(typeof BookContract)["input"], typeof Input>>;
export type KeepsTheErrors = Expect<Equal<(typeof BookContract)["errors"], readonly [typeof SeatTaken, typeof NoSuchSeat]>>;
export type NoErrorsIsEmpty = Expect<Equal<(typeof LogContract)["errors"], readonly []>>;

const decide = (c: { seatId: string; row: number }) =>
  c.row > 99 ? fail(new NoSuchSeat({ seatId: c.seatId })) : c.row < 0 ? fail(new SeatTaken({ seatId: c.seatId })) : emit(SeatBooked(c));
const Spread = defineCommand({ ...BookContract, decide: (_state, c) => decide(c) });
const Direct = defineCommand({ name: "book", input: Input, errors: [SeatTaken, NoSuchSeat], decide: (_state, c) => decide(c) });
export type SpreadIsTheDirectType = Expect<Equal<typeof Spread, typeof Direct>>;
export const asErased: Command<any, any> = Spread;

// a contract held in a const keeps the "decide may only fail with declared errors" check, whether it declares none or some
const NoneDeclared = commandContract({ name: "forgets", input: Input });
defineCommand({
  ...NoneDeclared,
  // @ts-expect-error SeatTaken is not declared by the contract
  decide: (_state, c) => fail(new SeatTaken({ seatId: c.seatId }))
});
const OneDeclared = commandContract({ name: "one", input: Input, errors: [SeatTaken] });
defineCommand({
  ...OneDeclared,
  // @ts-expect-error NoSuchSeat is not declared by the contract
  decide: (_state, c) => fail(new NoSuchSeat({ seatId: c.seatId }))
});
defineCommand({ ...OneDeclared, decide: (_state, c) => fail(new SeatTaken({ seatId: c.seatId })) });
