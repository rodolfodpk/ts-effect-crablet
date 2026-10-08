# Expose a command over HTTP

You list the command's **contract** (its name, input Schema and domain errors) and get `POST /api/commands/<name>`, validated against the input, with every failure
documented in a generated OpenAPI description. No HTTP code is written per command. The example is the course app; [tutorial step 3](../tutorial/03-an-http-api.md)
runs it with `curl`.

[← Task guides](README.md)

## 1. Declare the contract

Its own file, importing nothing that decides anything, so a browser can import it too.

<!-- file: examples/course-enrolment-app/src/domain/enrolment.contract.ts#contracts -->
```ts
export const DefineCourseContract = commandContract({
  name: "define_course",
  input: Schema.Struct({ courseId: Schema.String, capacity: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)) })
});

export const SubscribeContract = commandContract({
  name: "subscribe",
  input: Schema.Struct({ studentId: Schema.String, courseId: Schema.String }),
  errors: [CourseNotFound, CourseFull, StudentAtLimit]
});
```

Each error class carries a `kind` (`not_found`, `invalid`, `conflict`, `forbidden`); the API maps it to 404, 400, 409 or 403.

## 2. Build the command from the contract

Spread the contract into `defineCommand` and add the decision ([tutorial step 2](../tutorial/02-postgres-and-the-second-rule.md)).

## 3. List the contracts

<!-- file: examples/course-enrolment-app/src/CourseApi.ts#expose -->
```ts
// The write API: one route per contract, POST /api/commands/<name>. A contract's declared `errors` are what the API presents
// (status from each error's kind) and documents; there is no HTTP code to write per command. This module imports only the
// CONTRACTS, never how a decision is made, so a browser can import it.
// Do not annotate this list (`ReadonlyArray<...>`): that forgets the contract names, and the API's type (and so a client derived
// from it) is typed per command only while the names stay literal.
export const courseContracts = [DefineCourseContract, SubscribeContract];
```

## 4. Give the server the commands

A missing or extra command does not compile.

<!-- file: examples/course-enrolment-app/src/CourseApp.ts#implementations -->
```ts
// The server's side of the contracts: the command built from each one. A missing or extra command does not compile, and one that was not
// built from its contract is refused when the layer is built.
const courseImplementations: Implementations<typeof courseContracts> = { define_course: DefineCourse, subscribe: Subscribe };
```

## 5. Regenerate the description

The OpenAPI document is checked in ([`docs/api/`](../api)) and a unit test fails if it is stale, so an API change shows up as a diff. In the course app:
`node scripts/generate-openapi.ts` from `examples/course-enrolment-app`. A command answers with a **marker**; a read that carries it sees that write
([tutorial step 4](../tutorial/04-read-your-own-writes.md)). Reference: [`@crablet/commands-http`](../../packages/commands-http/README.md).
