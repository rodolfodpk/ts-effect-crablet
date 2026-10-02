// Compile-time tests (no runtime, never executed: the file is not a `*.test.ts`): `bun run typecheck` fails if a defined
// command stops carrying its input Schema and its declared error classes in its type. A transport (commands-http) derives
// a typed payload and one typed problem per declared error from them.
import * as Schema from "effect/Schema";
import { defineCommand, emit, fail } from "../src/Command.ts";
import type { Command } from "../src/Command.ts";
import { DomainError } from "../src/Errors.ts";
import type { AnyDomainErrorClass } from "../src/Errors.ts";
import { defineEvent } from "../src/Event.ts";

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Expect<T extends true> = T;

class SeatTaken extends DomainError("SeatTaken", { fields: { seatId: Schema.String }, kind: "conflict" }) {}
class NoSuchSeat extends DomainError("NoSuchSeat", { fields: { seatId: Schema.String }, kind: "not_found" }) {}

const SeatBooked = defineEvent("SeatBooked", { schema: Schema.Struct({ seatId: Schema.String }), tags: (d) => ({ seat_id: d.seatId }) });
const Input = Schema.Struct({ seatId: Schema.String, row: Schema.Int });

const Book = defineCommand({
  name: "book",
  errors: [SeatTaken, NoSuchSeat],
  input: Input,
  decide: (_state, c) => (c.row > 99 ? fail(new NoSuchSeat({ seatId: c.seatId })) : c.row < 0 ? fail(new SeatTaken({ seatId: c.seatId })) : emit(SeatBooked(c)))
});
const Record_ = defineCommand({ name: "record", input: Input, decide: (_state, c) => emit(SeatBooked(c)) });

// the input Schema itself is kept (not only its decoded type)...
export type KeepsTheInputSchema = Expect<Equal<typeof Book.input, typeof Input>>;
// ...and so are the declared error classes, in order
export type KeepsTheErrorClasses = Expect<Equal<typeof Book.errors, readonly [typeof SeatTaken, typeof NoSuchSeat]>>;
// a command that declares none carries the empty tuple
export type NoErrorsIsEmpty = Expect<Equal<typeof Record_.errors, []>>;
// the decoded input and the error instances are still what they were
export type StillTheDecodedInput = Expect<Equal<typeof Book extends Command<infer In, infer _E, infer _I, infer _Es> ? In : never, { readonly seatId: string; readonly row: number }>>;
export type StillTheErrorInstances = Expect<Equal<typeof Book extends Command<infer _In, infer E, infer _I, infer _Es> ? E : never, SeatTaken | NoSuchSeat>>;

// code that accepts "any command" is unaffected: a precisely typed command is assignable to the erased one
export const acceptsAnyCommand = (command: Command<any, any>): string => command.name;
acceptsAnyCommand(Book);
acceptsAnyCommand(Record_);
export const acceptsErasedParameters = (input: Schema.Constraint, errors: ReadonlyArray<AnyDomainErrorClass>): number => errors.length + (input ? 1 : 0);
acceptsErasedParameters(Book.input, Book.errors);

// a command whose declared errors do not cover what `decide` can fail with is still a compile error (unchanged)
defineCommand({
  name: "missing",
  input: Input,
  // @ts-expect-error SeatTaken is not declared in `errors`
  decide: (_state, c) => fail(new SeatTaken({ seatId: c.seatId }))
});
