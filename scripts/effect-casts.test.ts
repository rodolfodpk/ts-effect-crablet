// No value is cast to an Effect type (`Effect.Effect`, `Layer.Layer`, `Stream.Stream`, `ManagedRuntime`). Their requirements (R) and errors (E) are
// what the compiler checks for us; a cast turns "does not compile" into "service not found" at run time (CLAUDE.md, "Type safe").
//
// One rule, everywhere (sources, tests, diagnostics, scripts), with no exception: no cast to an Effect type, `as` or `as unknown as`.
// What these casts used to hide, and what replaced them:
//   - 81 `as unknown as Layer.Layer<…, never>` in tests and diagnostics hid the layer's construction error (`SqlError`: the pool could not
//     connect). `.pipe(Layer.orDie)` says that honestly: a failure to build is a defect there, and the services stay checked;
//   - `as Effect.Effect<…>` in CommandExecutor.ts was not needed: the inferred type was already the declared one;
//   - `as Effect.Effect<unknown, SchemaError>` in Repeat.ts hid a real requirement: an input schema could need a service to encode. A command's
//     input is now an `InputSchema` (Contract.ts), which needs none;
//   - `step2Demo.ts` ran its program as `Effect<A, E, any>` cast to `never`; it now takes exactly what `Crablet.layer` provides.
//   - 87 more in tests and scripts (most a `run` helper taking `Effect<A, E, any>`): 40 files compiled without them (they hid only the error
//     channel); the rest took `runWith` (@crablet/test-support/RunWith) or a precise `R`, and two typed-client tests had their `any` client
//     removed, which showed a `query: {}` the endpoints do not have and an error union read without narrowing.
// A cast through a function type or through `never`/`any` is not caught by a text scan; those are counted
// by the type-escape ratchet instead.
//
// An Effect or a runtime TAKEN with `any` requirements erases them as a cast does, without one: a helper `run(e: Effect.Effect<A, E, any>)` accepts an
// effect that needs a service the runtime does not have, and `ManagedRuntime<any, any>` says nothing of what it provides. Fifteen helpers like these
// (tests and diagnostics) took the runtime's exact services instead (`ManagedRuntime.ManagedRuntime.Services<typeof runtime>`, a runtime typed from
// its layer, or `typeof runtime.runPromise`), and the `runPromise(x as never)` they forced went with them. A type-level pattern match
// (`T extends (...a: any[]) => Effect.Effect<any, infer E, any>`) is not a requirement erased, and is left alone.
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dir, "..");
const skip = new Set(["node_modules", ".git", "dist", "coverage", ".idea", ".claude"]);
const walk = (dir: string): ReadonlyArray<string> =>
  readdirSync(dir).flatMap((name) => {
    if (skip.has(name)) return [];
    const full = path.join(dir, name);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });

const sources = ["packages", "examples", "tools", "scripts"]
  .flatMap((dir) => walk(path.join(root, dir)))
  .filter((f) => /\.(ts|tsx)$/u.test(f) && f !== import.meta.path);
const isSource = (f: string) => /[\\/]src[\\/]/u.test(f);

// Any cast to an Effect type: `as Effect.Effect<`, `as unknown as Layer.Layer<`, `as Layer<`, `as Stream.Stream<`, `as ManagedRuntime<`..., across line breaks.
export const effectCast =
  /\bas\s+(?:unknown\s+as\s+)?(?:Effect\.Effect|Effect|Layer\.Layer|Layer|Stream\.Stream|Stream|ManagedRuntime\.ManagedRuntime|ManagedRuntime)\s*</u;

// `Effect.Effect<…, any>` and `ManagedRuntime<…, any>` / `ManagedRuntime<any, …>` outside a conditional type (a line with `extends`).
export const anyRequirements =
  /^(?![^\n]*\bextends\b)[^\n]*(?:\bEffect\.Effect<[^\n;]*?,\s*any\s*>|\bManagedRuntime(?:\.ManagedRuntime)?<\s*any\b|\bManagedRuntime(?:\.ManagedRuntime)?<[^\n;]*?,\s*any\s*>)/mu;

const offendersOf = (pattern: RegExp, files: ReadonlyArray<string>) =>
  files.filter((f) => pattern.test(readFileSync(f, "utf8"))).map((f) => path.relative(root, f));

describe("casts to Effect types", () => {
  test("the scan sees the sources (so an empty walk cannot make this pass)", () => {
    expect(sources.length).toBeGreaterThan(100);
    expect(sources.filter(isSource).length).toBeGreaterThan(50);
  });

  test("the patterns catch each kind of cast they are meant to (so a broken pattern cannot make this pass)", () => {
    for (const cast of [
      "x as Effect.Effect<A, E>",
      "x as unknown as Effect.Effect<A>",
      "x as unknown as Layer.Layer<A, never>",
      "x as Layer<A>",
      "x as Stream.Stream<A>",
      "x as unknown as ManagedRuntime.ManagedRuntime<R, never>",
      "x\n  as unknown as\n  Layer.Layer<\n A>"
    ]) expect(effectCast.test(cast)).toBe(true);
    for (const fine of ["Layer.orDie(x)", "const layer: Layer.Layer<A> = x", "x.pipe(Layer.orDie)"]) {
      expect(effectCast.test(fine)).toBe(false);
    }
  });

  test("no file casts to an Effect type", () => {
    expect(offendersOf(effectCast, sources)).toEqual([]);
  });

  test("the requirements pattern catches an Effect or a runtime taken with any requirements, and leaves type-level matches alone", () => {
    for (const erased of [
      "const run = <A, E>(e: Effect.Effect<A, E, any>) => runtime.runPromise(e);",
      "const exitAll = (effects: ReadonlyArray<Effect.Effect<any, any, any>>) =>",
      "let runtime: ManagedRuntime.ManagedRuntime<any, any>;",
      "let runtime: ManagedRuntime<Services, any>;"
    ]) expect(anyRequirements.test(erased)).toBe(true);
    for (const fine of [
      "const run = <A, E>(e: Effect.Effect<A, E, Services>) => runtime.runPromise(e);",
      "type HandlerErr<C extends { handler: (...a: any[]) => Effect.Effect<any, any, any> }> = Effect.Error<ReturnType<C[\"handler\"]>>;",
      "const exitAll = <A, R>(effects: ReadonlyArray<Effect.Effect<A, unknown, R>>) =>"
    ]) expect(anyRequirements.test(fine)).toBe(false);
  });

  test("no file takes an Effect or a runtime with any requirements", () => {
    expect(offendersOf(anyRequirements, sources)).toEqual([]);
  });
});
