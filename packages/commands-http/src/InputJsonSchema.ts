import * as Schema from "effect/Schema";
import type { Command } from "@crablet/commands/Command";

// The JSON Schema (draft 2020-12, which OpenAPI 3.1 uses) of a command's input: what the API description shows as its
// request body. Generated from the very schema the command validates with, so the two cannot drift.
export const inputJsonSchema = (command: Command<any, any>): unknown =>
  Schema.toJsonSchemaDocument(command.input as unknown as Schema.Top);

// Things in an input schema that make the generated description wrong or misleading. Empty = fine.
//
//  - `Schema.Number` renders as "a number, or one of the strings Infinity / -Infinity / NaN" and its
//    `isGreaterThan(...)` checks are not emitted. Use `Schema.Finite` (or `Schema.Int`), which keep their
//    checks and reject non-finite values at the boundary.
export const inputJsonSchemaProblems = (command: Command<any, any>): ReadonlyArray<string> => {
  const text = JSON.stringify(inputJsonSchema(command));
  return text.includes('"Infinity"')
    ? [`command "${command.name}": an input field uses Schema.Number; use Schema.Finite or Schema.Int so its checks reach the API description`]
    : [];
};
