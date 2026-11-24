import { describe, expect, test } from "bun:test";
import { Effect, Exit } from "effect";
import * as Views from "@crablet/views";
import * as Deadlines from "@crablet/deadlines";
import * as Crablet from "../src/index.ts";

const declaration = Crablet.modules(Views.module({ views: [] })).with(Deadlines.module({ commands: [] }));
const roles = (modules: ReadonlyArray<string> | "all"): Crablet.Roles<"api"> => ({ app: new Set(["api"] as const), declared: ["api"], modules });

describe("the roles of the configuration, checked against the declaration", () => {
  test("`all` runs every module declared", async () => {
    expect(await Effect.runPromise(Crablet.runOf(declaration, roles("all")))).toBeUndefined();
  });

  test("the kinds named run, and only those", async () => {
    expect(await Effect.runPromise(Crablet.runOf(declaration, roles(["deadlines"])))).toEqual(["deadlines"]);
    expect(await Effect.runPromise(Crablet.runOf(declaration, roles([])))).toEqual([]);
  });

  test("a name that is not a declared kind is UnknownRole, naming it and every valid role", async () => {
    const exit = await Effect.runPromiseExit(Crablet.runOf(declaration, roles(["views", "outbox"])));
    expect(Exit.isFailure(exit)).toBe(true);
    const error = Exit.isFailure(exit) ? exit.cause.reasons.map((r) => (r._tag === "Fail" ? r.error : undefined))[0] : undefined;
    expect(error).toBeInstanceOf(Crablet.UnknownRole);
    expect(error?.message).toBe('"outbox" is not a role of this process; the roles are api, views, deadlines, all');
  });
});
