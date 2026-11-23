# Working in this repository

How to build, test and change things is in [CONTRIBUTING.md](CONTRIBUTING.md); decisions are in [docs/adr](docs/adr/README.md). This file holds the rules
that apply to every change.

## Type safe

Using Effect and TypeScript only makes sense if the types tell the truth: an Effect's or a Layer's `R` lists what it really needs, and its `E` what can
really fail. A cast that erases them turns "does not compile" into "service not found" at run time.

1. **No cast to an Effect type.** Never write `as Effect.Effect<…>`, `as Layer.Layer<…>`, `as Stream.Stream<…>` or `as ManagedRuntime<…>`, with or without
   `unknown`, nor an `as any` / `as never` that stands in for one. A wrong `R` or `E` is fixed in the code. `scripts/effect-casts.test.ts` enforces it
   everywhere (sources, tests, diagnostics, scripts), with no exception. To run an Effect in a test, use `runWith(layer)` from
   `@crablet/test-support/RunWith`, whose `run` takes exactly what the layer provides.
2. **An honest `E`.** A layer that can fail to build (`SqlError`, `ConfigError`) says so. `orDie` is not a cast: it is allowed where the failure really is a
   defect at that boundary (a test that cannot reach its database, an admin endpoint answering 500), with the reason in a comment, never to silence the compiler.
3. **Requirements are derived, not written by hand.** A hand-written requirements type drifts unnoticed; take it from the code (`Effect.Services<…>`), or
   check it against the code with a compile-time equality. Example: `CommandApiRequirements` (`packages/commands-http/src/CommandApiLive.ts`) is read off
   the layer type `HttpApiBuilder.group` infers, and `test/command-group-live.types.ts` pins it.
4. **Every TypeScript file is type-checked.** A new folder of `.ts` files goes into a `tsconfig.json` `include`; `scripts/typecheck-coverage.test.ts`
   fails when a versioned file is in none. Every tsconfig is strict, with `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`,
   `noUnusedLocals`, `noUnusedParameters`, `noImplicitOverride` and `noFallthroughCasesInSwitch`. An option the code reads with a default is typed
   `x?: T | undefined`, so a caller may pass `undefined` for "the default".
5. **A type escape that must stay** (`as unknown as`, `as never`, `as any`, `: any`, `<any>`: a generic `Schema` boundary, a dynamic HTTP group) says why on
   its line or the line above, `// type escape: <why>`. The others are counted per workspace against `crablet.typeEscapes` in its `package.json`
   (`scripts/type-escapes.test.ts`): the count may not grow, and when you remove escapes, lower it with `bun run type-escapes:baseline`.
6. **A public API has type tests** (`// @ts-expect-error`) for what must not compile, so a type is shown to be precise and not merely accepted. Check that
   each one bites: remove it and see the compiler complain.

## SOLID

Every change follows the five principles:

- **Single responsibility**: a module, a file or a package has one reason to change. A file every package edits for its own reasons (a central list of
  exceptions, a baseline with many owners) has many.
- **Open/closed**: adding a kind of thing (a module, a command, a view) does not mean editing the code that hosts the others.
- **Liskov substitution**: implementations of one contract are interchangeable, and a test shows it by running against each.
- **Interface segregation**: a consumer is not made to require what it does not use, in its types (`R`) or in the interface it takes.
- **Dependency inversion**: policy depends on abstractions; a lower-level package does not know the modules built on it.

**A violation is never accepted silently**, whether it comes with a new change or is found in existing code. Report it to the maintainer with the
principle, what is at stake, the options and a recommendation, and let the maintainer decide. Record the decision in an ADR (or in the plan, until the
ADR exists). "It is acceptable" and "it is out of scope" are the maintainer's calls, not the author's.
