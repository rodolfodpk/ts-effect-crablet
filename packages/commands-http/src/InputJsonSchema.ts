import * as Schema from "effect/Schema";
import type { Command } from "@crablet/commands/Command";

// The JSON Schema (draft 2020-12, which OpenAPI 3.1 uses) of a command's input: what the API description shows as its
// request body. Generated from the very schema the command validates with, so the two cannot drift.
export const inputJsonSchema = (command: Pick<Command<any, any>, "input">): unknown =>
  Schema.toJsonSchemaDocument(command.input as unknown as Schema.Top);

// Things in an input schema that make the generated description wrong or misleading. Empty = fine.
//
//  - `Schema.Number` renders as "a number, or one of the strings Infinity / -Infinity / NaN" and its
//    `isGreaterThan(...)` checks are not emitted. Use `Schema.Finite` (or `Schema.Int`), which keep their
//    checks and reject non-finite values at the boundary.
//  - `Schema.optional(X)` (the value may be `undefined`) is described as "X or null", but a JSON `null` is
//    refused when the request is decoded. Use `Schema.optionalKey(X)` (the key may be absent), which is
//    described as plain X.
export const inputJsonSchemaProblems = (command: Pick<Command<any, any>, "name" | "input">): ReadonlyArray<string> => {
  const problems: Array<string> = [];
  if (JSON.stringify(inputJsonSchema(command)).includes('"Infinity"')) {
    problems.push(`command "${command.name}": an input field uses Schema.Number; use Schema.Finite or Schema.Int so its checks reach the API description`);
  }
  for (const path of optionalFieldsAcceptingUndefined(command.input as unknown as Schema.Top, [])) {
    problems.push(`command "${command.name}": field "${path}" uses Schema.optional; use Schema.optionalKey so it is not described as nullable`);
  }
  return problems;
};

// Struct fields (at any depth of nested structs) declared with `Schema.optional`: optional AND able to be `undefined`.
const optionalFieldsAcceptingUndefined = (schema: Schema.Top, prefix: ReadonlyArray<string>): ReadonlyArray<string> => {
  const fields = (schema as { readonly fields?: Record<string, Schema.Top> }).fields;
  if (fields === undefined) return [];
  return Object.entries(fields).flatMap(([name, field]) => {
    const ast = field.ast as { readonly context?: { readonly isOptional?: boolean }; readonly types?: ReadonlyArray<{ readonly _tag: string }> };
    const path = [...prefix, name];
    const acceptsUndefined = ast.context?.isOptional === true && (ast.types ?? []).some((t) => t._tag === "Undefined");
    return [...(acceptsUndefined ? [path.join(".")] : []), ...optionalFieldsAcceptingUndefined(field, path)];
  });
};
