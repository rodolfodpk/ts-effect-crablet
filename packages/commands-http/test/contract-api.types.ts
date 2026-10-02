// Compile-time tests (never executed): the command API declared from CONTRACTS. The client derived from it is typed per command, and
// `Implementations` ties the server's commands to the contracts.
import { Effect } from "effect";
import * as Schema from "effect/Schema";
import { HttpApi, HttpApiBuilder, HttpApiClient, OpenApi } from "effect/http-api";
import { defineCommand, emit, fail } from "@crablet/commands/Command";
import { commandContract } from "@crablet/commands/Contract";
import { DomainError } from "@crablet/commands/Errors";
import { defineEvent } from "@crablet/commands/Event";
import { makeCommandApiGroup, withApiInfo } from "../src/CommandApi.ts";
import type { Implementations } from "../src/CommandApi.ts";

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Expect<T extends true> = T;

class SeatTaken extends DomainError("SeatTaken", { fields: { seatId: Schema.String, row: Schema.Int }, kind: "conflict" }) {}
class NoSuchSeat extends DomainError("NoSuchSeat", { fields: { seatId: Schema.String }, kind: "not_found" }) {}
const SeatBooked = defineEvent("SeatBooked", { schema: Schema.Struct({ seatId: Schema.String }), tags: (d) => ({ seat_id: d.seatId }) });

const BookContract = commandContract({ name: "book", input: Schema.Struct({ seatId: Schema.String, row: Schema.Int }), errors: [SeatTaken, NoSuchSeat] });
const LogContract = commandContract({ name: "log", input: Schema.Struct({ note: Schema.String }) });
const contracts = [BookContract, LogContract];

// ---- the API and the client derived from it ----
const group = makeCommandApiGroup("/api/commands", contracts, { waitableViews: ["seats"] });
export const api = withApiInfo(HttpApi.make("x").add(group), { title: "t", version: "1" });
export const description = OpenApi.fromApi(api);
export const serving = HttpApiBuilder.layer(api);

export const program = Effect.gen(function* () {
  const client = yield* HttpApiClient.make(api);
  const booked = yield* client.commands.execute_book({ query: {}, payload: { seatId: "12A", row: 3 } });
  // @ts-expect-error a misspelled payload field
  yield* client.commands.execute_book({ query: {}, payload: { seatID: "12A", row: 3 } });
  // @ts-expect-error the payload of ANOTHER command
  yield* client.commands.execute_log({ query: {}, payload: { seatId: "12A", row: 3 } });
  // @ts-expect-error a command that has no contract
  yield* client.commands.execute_nope({ query: {}, payload: {} });
  return booked;
});
const clientShape = Effect.gen(function* () {
  return yield* HttpApiClient.make(api);
});
type Client = Effect.Success<typeof clientShape>;
type BookError = Effect.Error<ReturnType<Client["commands"]["execute_book"]>>;
type LogError = Effect.Error<ReturnType<Client["commands"]["execute_log"]>>;
type DomainProblems<E> = Extract<E, { readonly errorType: string }>;
export type BookDeclaresTwo = Expect<Equal<DomainProblems<BookError>["errorType"], "SeatTaken" | "NoSuchSeat">>;
export type LogDeclaresNone = Expect<Equal<DomainProblems<LogError>, never>>;
export type FieldsAreExact = Expect<
  Equal<Extract<DomainProblems<BookError>, { readonly errorType: "SeatTaken" }>["fields"], { readonly seatId: string; readonly row: number }>
>;

// ---- the server's side ----
const Book = defineCommand({
  ...BookContract,
  decide: (_s, c) => (c.row > 99 ? fail(new NoSuchSeat({ seatId: c.seatId })) : c.row < 0 ? fail(new SeatTaken({ seatId: c.seatId, row: c.row })) : emit(SeatBooked(c)))
});
const Log = defineCommand({ ...LogContract, decide: (_s, c) => emit(SeatBooked({ seatId: c.note })) });
export const complete: Implementations<typeof contracts> = { book: Book, log: Log };

// @ts-expect-error `log` has no implementation
export const missing: Implementations<typeof contracts> = { book: Book };
// @ts-expect-error `extra` has no contract
export const extra: Implementations<typeof contracts> = { book: Book, log: Log, extra: Log };
// @ts-expect-error `book` is implemented by a command built from another contract
export const swapped: Implementations<typeof contracts> = { book: Log, log: Log };

// an error the API cannot present (a plain string) makes the command unacceptable
const Plain = defineCommand({ ...LogContract, decide: () => fail("nope") });
// @ts-expect-error a command that fails with a plain string is not presentable
export const notPresentable: Implementations<typeof contracts> = { book: Book, log: Plain };
