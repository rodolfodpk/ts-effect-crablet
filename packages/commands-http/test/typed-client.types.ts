// Compile-time tests (never executed; not a `*.test.ts`): the command API\'s STATIC type. A client derived from the API
// (`HttpApiClient.make`) is typed per command: the payload is the command\'s own input Schema, and the failures are the
// framework\'s problems plus one problem per domain error the command declared. `bun run typecheck` fails if any of this
// regresses (every `@ts-expect-error` below must still be an error).
import { Effect } from "effect";
import * as Schema from "effect/Schema";
import { HttpApi, HttpApiBuilder, HttpApiClient, OpenApi } from "effect/http-api";
import type { HttpClientError } from "effect/http/HttpClientError";
import { defineCommand, emit, fail } from "@crablet/commands/Command";
import { DomainError } from "@crablet/commands/Errors";
import { defineEvent } from "@crablet/commands/Event";
import { makeCommandApi, makeCommandApiGroup, withApiInfo } from "../src/CommandApi.ts";
import { exposedCommandOf } from "../src/ExposedCommand.ts";
import type { ExposedCommand } from "../src/ExposedCommand.ts";

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Expect<T extends true> = T;

class SeatTaken extends DomainError("SeatTaken", { fields: { seatId: Schema.String, row: Schema.Int }, kind: "conflict" }) {}
class NoSuchSeat extends DomainError("NoSuchSeat", { fields: { seatId: Schema.String }, kind: "not_found" }) {}
const SeatBooked = defineEvent("SeatBooked", { schema: Schema.Struct({ seatId: Schema.String }), tags: (d) => ({ seat_id: d.seatId }) });
const Book = defineCommand({
  name: "book",
  errors: [SeatTaken, NoSuchSeat],
  input: Schema.Struct({ seatId: Schema.String, row: Schema.Int }),
  decide: (_state, c) => (c.row > 99 ? fail(new NoSuchSeat({ seatId: c.seatId })) : c.row < 0 ? fail(new SeatTaken({ seatId: c.seatId, row: c.row })) : emit(SeatBooked(c)))
});
const Log = defineCommand({ name: "log", input: Schema.Struct({ note: Schema.String }), decide: (_state, c) => emit(SeatBooked({ seatId: c.note })) });

// the registry is written WITHOUT an annotation, so its keys stay literal
const registry = { book: exposedCommandOf(Book), log: exposedCommandOf(Log) };
const group = makeCommandApiGroup("/api/commands", registry, { waitableViews: ["seats"] });
export const api = withApiInfo(HttpApi.make("x").add(group), { title: "t", version: "1" });

// the things that consume the API\'s type accept the typed group
export const description = OpenApi.fromApi(api);
export const serving = HttpApiBuilder.layer(api);
export const standalone = makeCommandApi("/api/commands", registry);

export const program = Effect.gen(function* () {
  const client = yield* HttpApiClient.make(api);
  const booked = yield* client.commands.execute_book({ query: {}, payload: { seatId: "12A", row: 3 } });
  const logged = yield* client.commands.execute_log({ query: { waitFor: "seats" }, payload: { note: "hi" } });
  // @ts-expect-error a misspelled payload field
  yield* client.commands.execute_book({ query: {}, payload: { seatID: "12A", row: 3 } });
  // @ts-expect-error a payload field of the wrong type
  yield* client.commands.execute_book({ query: {}, payload: { seatId: "12A", row: "3" } });
  // @ts-expect-error the payload of ANOTHER command
  yield* client.commands.execute_log({ query: {}, payload: { seatId: "12A", row: 3 } });
  // @ts-expect-error a command that is not in the registry
  yield* client.commands.execute_nope({ query: {}, payload: {} });
  return [booked, logged] as const;
});

const clientShape = Effect.gen(function* () {
  return yield* HttpApiClient.make(api);
});
type Client = Effect.Success<typeof clientShape>;
type BookCall = ReturnType<Client["commands"]["execute_book"]>;
type LogCall = ReturnType<Client["commands"]["execute_log"]>;

// success: the real response objects
type BookSuccess = Effect.Success<BookCall>;
export type SuccessIsCreatedOrIdempotent = Expect<Equal<BookSuccess["status"], "CREATED" | "IDEMPOTENT">>;

// failures: the framework\'s, the transport\'s, and exactly the declared domain errors of THAT command
type BookError = Effect.Error<BookCall>;
type LogError = Effect.Error<LogCall>;
type DomainProblems<E> = Extract<E, { readonly errorType: string }>;
export type BookDeclaresTwo = Expect<Equal<DomainProblems<BookError>["errorType"], "SeatTaken" | "NoSuchSeat">>;
export type LogDeclaresNone = Expect<Equal<DomainProblems<LogError>, never>>;
export type TheFieldsAreExact = Expect<
  Equal<Extract<DomainProblems<BookError>, { readonly errorType: "SeatTaken" }>["fields"], { readonly seatId: string; readonly row: number }>
>;
export type TransportErrorsAreInTheChannel = Expect<Equal<HttpClientError extends BookError ? true : false, true>>;
export type SchemaErrorsAreInTheChannel = Expect<Equal<Schema.SchemaError extends BookError ? true : false, true>>;

// a `switch` over `errorType` is exhaustive: handling every declared error leaves nothing, leaving one out does not compile
export const describe = (e: DomainProblems<BookError>): string => {
  switch (e.errorType) {
    case "SeatTaken":
      return `${e.fields.seatId} row ${e.fields.row}`;
    case "NoSuchSeat":
      return e.fields.seatId;
    default: {
      const _exhaustive: never = e;
      return _exhaustive;
    }
  }
};
export const describeIncomplete = (e: DomainProblems<BookError>): string => {
  switch (e.errorType) {
    case "SeatTaken":
      return e.fields.seatId;
    default: {
      // @ts-expect-error NoSuchSeat is not handled
      const _exhaustive: never = e;
      return String(_exhaustive);
    }
  }
};

// a registry ANNOTATED as a Record still compiles (it degrades to one endpoint typed by a `string` key)
const erased: Readonly<Record<string, ExposedCommand<any, any>>> = registry;
export const erasedGroup = makeCommandApiGroup("/api/commands", erased);
