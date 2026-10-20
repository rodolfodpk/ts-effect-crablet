// Compile-time tests (never executed): a caller's input to `run`, `when` and `assertRepeatHarmless` is typed from the command's schema, so a misspelt,
// missing or wrongly typed field does not compile. It is still validated at run time (scenario.test.ts, "malformed input is InvalidInput").
import { Effect } from "effect";
import * as Schema from "effect/Schema";
import { defineCommand, emit, type Command } from "../src/Command.ts";
import { CommandExecutor } from "../src/CommandExecutor.ts";
import { defineEvent } from "../src/Event.ts";
import { assertRepeatHarmless, given } from "../src/testing/Scenario.ts";

const Noted = defineEvent("RI_Noted", { schema: Schema.Struct({ id: Schema.String, at: Schema.Date }), tags: (d) => ({ note_id: d.id }) });
// `at` is a Date decoded from a string: the caller gives the string.
const Note = defineCommand({
  name: "ri_note",
  input: Schema.Struct({ id: Schema.String, at: Schema.DateFromString }),
  idempotentBy: (c) => Noted.where({ note_id: c.id }),
  decide: (_s, c) => emit(Noted(c))
});

export const accepted = Effect.gen(function* () {
  const executor = yield* CommandExecutor;
  yield* executor.run(Note, { id: "n1", at: "2026-10-20T00:00:00Z" });
  // A command whose schema type is erased takes any input, as a transport has it.
  const erased: Command<unknown, never> = Note as never;
  yield* executor.run(erased, JSON.parse("{}"));
});
export const acceptedWhen = given().when(Note, { id: "n1", at: "2026-10-20T00:00:00Z" });

export const refused = Effect.gen(function* () {
  const executor = yield* CommandExecutor;
  // @ts-expect-error a misspelt field
  yield* executor.run(Note, { idd: "n1", at: "2026-10-20T00:00:00Z" });
  // @ts-expect-error a missing field
  yield* executor.run(Note, { id: "n1" });
  // @ts-expect-error the decoded type of a transformed field: the caller gives what the schema decodes from
  yield* executor.run(Note, { id: "n1", at: new Date() });
});
// @ts-expect-error a wrongly typed field
export const refusedWhen = given().when(Note, { id: 1, at: "2026-10-20T00:00:00Z" });
// @ts-expect-error a misspelt field
export const refusedRepeat = assertRepeatHarmless(Note, { idd: "n1", at: "2026-10-20T00:00:00Z" });
