import { Data, Effect, Layer } from "effect";
import type { Roles } from "./Config.ts";
import { processors, type Modules, type ProcessOptions } from "./Processors.ts";

// A role in the configuration that is neither one of the application's nor a module the declaration has: a typo, or a module this image does not
// declare. The process does not start, and the error says what would have been accepted.
export class UnknownRole extends Data.TaggedError("UnknownRole")<{ readonly role: string; readonly valid: ReadonlyArray<string> }> {
  override get message(): string {
    return `"${this.role}" is not a role of this process; the roles are ${this.valid.join(", ")}`;
  }
}

// The modules to run, from the configuration's roles, checked against the declaration: `undefined` (all of them) for `all`.
export const runOf = <Kind extends string, MakeR, RunR>(
  { list }: Modules<Kind, MakeR, RunR>,
  roles: Roles<string>
): Effect.Effect<ReadonlyArray<Kind> | undefined, UnknownRole> => {
  const { modules } = roles;
  if (modules === "all") return Effect.succeed(undefined);
  const kinds = list.map((m) => m.kind);
  return Effect.forEach(modules, (role) => {
    const kind = kinds.find((k) => k === role);
    return kind === undefined ? Effect.fail(new UnknownRole({ role, valid: [...roles.declared, ...kinds, "all"] })) : Effect.succeed(kind);
  });
};

// `Crablet.processors`, with `run` read from the configuration (`Crablet.config(...).roles`) instead of written in the code. A role the declaration
// does not have fails the layer with `UnknownRole`, before any module is built.
export const processorsFor = <Kind extends string, MakeR, RunR>(declaration: Modules<Kind, MakeR, RunR>, roles: Roles<string>, options: ProcessOptions = {}) =>
  Layer.unwrap(Effect.map(runOf(declaration, roles), (run) => processors(declaration, { ...options, run })));
