// Compile-time tests (never executed; not a `*.test.ts`): `exposedCommandOf` keeps the command's input Schema and declared
// error classes in its type, and an exposed command is still assignable to the erased `ExposedCommand<any, any>` that
// registries and the server side accept.
import * as Schema from "effect/Schema";
import { defineCommand, emit, fail } from "@crablet/commands/Command";
import { DomainError } from "@crablet/commands/Errors";
import { defineEvent } from "@crablet/commands/Event";
import { exposedCommandOf } from "../src/ExposedCommand.ts";
import type { ExposedCommand } from "../src/ExposedCommand.ts";

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Expect<T extends true> = T;

class SeatTaken extends DomainError("SeatTaken", { fields: { seatId: Schema.String }, kind: "conflict" }) {}
const SeatBooked = defineEvent("SeatBooked", { schema: Schema.Struct({ seatId: Schema.String }), tags: (d) => ({ seat_id: d.seatId }) });
const Input = Schema.Struct({ seatId: Schema.String });
const Book = defineCommand({
  name: "book",
  errors: [SeatTaken],
  input: Input,
  decide: (_state, c) => (c.seatId === "" ? fail(new SeatTaken({ seatId: c.seatId })) : emit(SeatBooked(c)))
});

const exposed = exposedCommandOf(Book);

export type KeepsTheInputSchema = Expect<Equal<typeof exposed.command.input, typeof Input>>;
export type KeepsTheErrorClasses = Expect<Equal<typeof exposed.command.errors, readonly [typeof SeatTaken]>>;

// registries written the old way still compile: the erased type accepts a precise one
export const erasedRegistry: Readonly<Record<string, ExposedCommand<any, any>>> = { book: exposed };
// and a registry with no annotation keeps its keys (what the typed API group will rely on)
const registry = { book: exposed };
export type KeepsTheKeys = Expect<Equal<keyof typeof registry, "book">>;
