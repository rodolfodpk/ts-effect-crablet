// No value is cast to an Effect type (`Effect.Effect`, `Layer.Layer`, `Stream.Stream`, `ManagedRuntime`). Their requirements (R) and errors (E) are
// what the compiler checks for us; a cast turns "does not compile" into "service not found" at run time (CLAUDE.md, "Type safe").
//
// Two rules, each with no exception:
//   - in source code (`src/`), no cast to an Effect type at all, `as` or `as unknown as`;
//   - anywhere, no `as unknown as Layer…` or `as unknown as ManagedRuntime…`.
// What these casts used to hide, and what replaced them:
//   - 81 `as unknown as Layer.Layer<…, never>` in tests and diagnostics hid the layer's construction error (`SqlError`: the pool could not
//     connect). `.pipe(Layer.orDie)` says that honestly: a failure to build is a defect there, and the services stay checked;
//   - `as Effect.Effect<…>` in CommandExecutor.ts was not needed: the inferred type was already the declared one;
//   - `as Effect.Effect<unknown, SchemaError>` in Repeat.ts hid a real requirement: an input schema could need a service to encode. A command's
//     input is now an `InputSchema` (Contract.ts), which needs none;
//   - `step2Demo.ts` ran its program as `Effect<A, E, any>` cast to `never`; it now takes exactly what `Crablet.layer` provides.
// Tests and scripts that still cast with a plain `as` (a `run` helper taking `Effect<A, E, any>`) are fixed in one go with a typed helper, and
// then the first rule covers them too. A cast through a function type or through `never`/`any` is not caught by a text scan; those are counted
// by the type-escape ratchet instead.
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
// A cast of a layer or a runtime through `unknown`.
export const unknownLayerCast = /\bas\s+unknown\s+as\s+(?:Layer\.Layer|Layer|ManagedRuntime\.ManagedRuntime|ManagedRuntime)\s*</u;

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
    for (const cast of ["x as unknown as Layer.Layer<A, never>", "x\n as unknown as ManagedRuntime<R, never>"]) expect(unknownLayerCast.test(cast)).toBe(true);
    for (const fine of ["Layer.orDie(x)", "const layer: Layer.Layer<A> = x", "x.pipe(Layer.orDie)"]) {
      expect(effectCast.test(fine)).toBe(false);
      expect(unknownLayerCast.test(fine)).toBe(false);
    }
  });

  test("no source file casts to an Effect type", () => {
    expect(offendersOf(effectCast, sources.filter(isSource))).toEqual([]);
  });

  test("no file casts a layer or a runtime through unknown", () => {
    expect(offendersOf(unknownLayerCast, sources)).toEqual([]);
  });
});
