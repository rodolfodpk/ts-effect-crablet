# Step 3 - an HTTP API, and its OpenAPI description

[← Step 2 - Postgres, and the second rule](02-postgres-and-the-second-rule.md) · [Tutorial index](README.md) · [Step 4 - read your own writes →](04-read-your-own-writes.md)

Exposing a command is one line each: you list its **contract**. Nothing else about HTTP is written:

<!-- file: examples/course-enrolment-app/src/CourseApi.ts#expose -->
```ts
// The write API: one route per contract, POST /api/commands/<name>. A contract's declared `errors` are what the API presents
// (status from each error's kind) and documents; there is no HTTP code to write per command. This module imports only the
// CONTRACTS, never how a decision is made, so a browser can import it.
// Do not annotate this list (`ReadonlyArray<...>`): that forgets the contract names, and the API's type (and so a client derived
// from it) is typed per command only while the names stay literal.
export const courseContracts = [DefineCourseContract, SubscribeContract];
```

`DefineCourseContract` and `SubscribeContract` are the two contracts you wrote in [step 2](02-postgres-and-the-second-rule.md) (name, input Schema and errors; the source is
[`enrolment.contract.ts`](../../examples/course-enrolment-app/src/domain/enrolment.contract.ts)); the whole file is
[`CourseApi.ts`](../../examples/course-enrolment-app/src/CourseApi.ts), which imports only contracts.

The route is the contract's `name`. Because the list keeps its contracts' literal names, the API's *type* has one endpoint per command: a client derived from it knows that
`subscribe` takes `{ studentId, courseId }` and can fail with `CourseNotFound`, `CourseFull` or `StudentAtLimit`. Annotating the list as `ReadonlyArray<...>` still works, but it forgets the names and the
client falls back to a single, loosely typed endpoint. The server hands the matching *commands* (`DefineCourse` and `Subscribe`, the contracts plus their decisions, also from step 2 and defined in [`Enrolment.ts`](../../examples/course-enrolment-app/src/domain/Enrolment.ts)) to the same API, one per contract:

<!-- file: examples/course-enrolment-app/src/CourseApp.ts#implementations -->
```ts
// The server's side of the contracts: the command built from each one. A missing or extra command does not compile, and one that was not
// built from its contract is refused when the layer is built.
const courseImplementations: Implementations<typeof courseContracts> = { define_course: DefineCourse, subscribe: Subscribe };
```

A missing command, an extra one, or one that was not built from its contract (not by spreading it) does not compile; the last is also checked when the server starts.

Start the server (add `COURSES_DOCS=scalar` to also serve a documentation page at `/docs`):

```bash
COURSES_DOCS=scalar node src/index.ts
```

In another terminal. Define a course and subscribe a student (the `lastPosition`, `lastTransactionId` and `marker` numbers will differ on your machine):

```bash
curl -si -X POST localhost:8080/api/commands/define_course \
  -H 'Content-Type: application/json' -d '{"courseId":"math-101","capacity":2}'
```

```
HTTP/1.1 201 Created
content-type: application/json

{"status":"CREATED","reason":null,"lastPosition":"10","lastTransactionId":"10","marker":"10:10"}
```

```bash
curl -s -X POST localhost:8080/api/commands/subscribe \
  -H 'Content-Type: application/json' -d '{"studentId":"ann","courseId":"math-101"}'
curl -s -X POST localhost:8080/api/commands/subscribe \
  -H 'Content-Type: application/json' -d '{"studentId":"ann","courseId":"math-101"}'
```

```
{"status":"CREATED","reason":null,"lastPosition":"11","lastTransactionId":"11","marker":"11:11"}
{"status":"IDEMPOTENT","reason":"ALREADY_SUBSCRIBED","lastPosition":null,"lastTransactionId":null,"marker":null}
```

The second call is a repeat: `200` and "already done", with nothing written (so no position and no marker). `marker` is the position and the transaction id as one string, `"<lastTransactionId>:<lastPosition>"`. Now fill the course and ask for a third seat:

```bash
curl -s -X POST localhost:8080/api/commands/subscribe \
  -H 'Content-Type: application/json' -d '{"studentId":"bob","courseId":"math-101"}'
curl -si -X POST localhost:8080/api/commands/subscribe \
  -H 'Content-Type: application/json' -d '{"studentId":"cy","courseId":"math-101"}'
```

```
{"status":"CREATED","reason":null,"lastPosition":"12","lastTransactionId":"12","marker":"12:12"}
HTTP/1.1 409 Conflict
content-type: application/problem+json

{"type":"urn:crablet:problem:command-api:conflict","title":"Conflict","status":409,"detail":"CourseFull","errorType":"CourseFull","fields":{"courseId":"math-101","capacity":2}}
```

The refusal is an RFC 7807 problem. You wrote no code for it: the status comes from the error's `kind` (`conflict` -> 409,
`not_found` -> 404), the body carries the error's own fields, and the response is `application/problem+json`. A payload that does not
match the command's input is a 400 problem that names every failing field by path (`errors`, never the value you sent), and defining a course twice is the framework's 409:

```bash
curl -s -X POST localhost:8080/api/commands/define_course \
  -H 'Content-Type: application/json' -d '{"courseId":"x","capacity":0}'
curl -s -X POST localhost:8080/api/commands/subscribe \
  -H 'Content-Type: application/json' -d '{"studentId":"ann","courseId":"ghost"}'
```

```
{"type":"urn:crablet:problem:command-api:bad-request","title":"Bad Request","status":400,"detail":"Invalid payload for command: define_course","errors":[{"path":["capacity"],"message":"Expected a value greater than or equal to 1"}]}
{"type":"urn:crablet:problem:command-api:not-found","title":"Not Found","status":404,"detail":"CourseNotFound","errorType":"CourseNotFound","fields":{"courseId":"ghost"}}
```

## The OpenAPI description

The API describes itself:

```bash
curl -s localhost:8080/openapi.json | head -c 200
```

```
{"openapi":"3.1.0","info":{"title":"Course Enrolment API","version":"1.0.0","description":"Define courses and subscribe students: a course holds at most `capacity` students, a student takes at most 3 courses."},"paths":{"/api/commands":{"get":{"tags":["commands"],...
```

Open <http://localhost:8080/docs> for a browsable page. What is in it was **generated** from your code: each command's request body is its
`input` schema (`capacity` is documented as an integer with `minimum: 1`), and `subscribe` documents exactly the three errors it declared,
each with its own typed fields (`CourseFull` has `courseId` and `capacity`). The document is also checked in at
[`docs/api/course-enrolment-openapi.json`](../api/course-enrolment-openapi.json), and a unit test fails if it is stale, so an API change
is a visible diff in review. Try it: add a field to `DefineCourse`'s input, run

```bash
node scripts/generate-openapi.ts
git diff ../../docs/api
```

and the diff shows the new request field. (Then `git checkout ../../docs/api` to undo.)

Clients: run any OpenAPI generator on `/openapi.json`, or derive one from the API itself with
`HttpApiClient.make(makeCourseApi(), { baseUrl })` (no codegen; see `test/integration/course-http.test.ts`). Why it is shaped this way:
[ADR-0011](../adr/0011-http-api-from-the-domain-model.md).

---

**You now have** an HTTP API with one route per command, domain errors as `application/problem+json`, and an OpenAPI description generated from your contracts and checked in.

[← Step 2 - Postgres, and the second rule](02-postgres-and-the-second-rule.md) · [Tutorial index](README.md) · [Step 4 - read your own writes →](04-read-your-own-writes.md)
