# Tutorial: course enrolment, from an in-memory test to an HTTP API

You will build a small service where **a course holds at most N students** and **a student takes at most 3 courses**. Those two
rules concern two different kinds of thing, yet they are decided together, atomically, without a saga and without picking an
"aggregate" first. That is what *dynamic consistency boundaries* (DCB) are for.

In five steps (about 40 minutes) you will:

1. write and test the rule **in memory** - no database, no Docker;
2. run it against **Postgres**, add the second rule, and watch two races resolve;
3. expose it as an **HTTP API** whose **OpenAPI** description is generated from your code;
4. add a **read model**, and make a read include a write (a **marker**, or the server's default) so a client reads its own write;
5. put a small **web page** (Foldkit) in front of it and see what a real client has to handle.

Every code block below is a real file in this repository; a test fails if a block drifts from its file
(`examples/course-enrolment-app/test/tutorial-sync.test.ts`). Reference material, if you want it: the
[README](../../README.md), the [DCB guide](../dcb-guide.md), [ADR-0010](../adr/0010-declarative-command-api.md) and
[ADR-0011](../adr/0011-http-api-from-the-domain-model.md).

**You need:** Bun 1.4 or newer, Node 24 or newer, and (from step 2) Docker. Then, once:

```bash
git clone https://github.com/rodolfodpk/ts-effect-crablet.git
cd ts-effect-crablet
bun install
```

---

## Step 1 - the rule, in memory

There are no streams and no aggregates. You declare three things.

**Events** - a name, a payload, and the *tags* an event can be found by:

<!-- file: examples/course-enrolment-app/tutorial/step1-capacity-only.test.ts#step1-domain -->
```ts
// 1. Events: a name, a payload, and the tags an event can be found by. There are no streams.
const CourseDefined = defineEvent("CourseDefined", {
  schema: Schema.Struct({ courseId: Schema.String, capacity: Schema.Int }),
  tags: (d) => ({ course_id: d.courseId })
});
const StudentSubscribed = defineEvent("StudentSubscribed", {
  schema: Schema.Struct({ studentId: Schema.String, courseId: Schema.String }),
  tags: (d) => ({ student_id: d.studentId, course_id: d.courseId })
});

// 2. A model: what the events mean for one course - and, from the same declaration, which events could change that
//    answer (the command's consistency boundary).
const CourseModel = defineModel({ by: "course_id", initial: () => ({ exists: false, capacity: 0, subscribers: 0 }) })
  .on(CourseDefined, (c, d) => ({ ...c, exists: true, capacity: d.capacity }))
  .on(StudentSubscribed, (c) => ({ ...c, subscribers: c.subscribers + 1 }));

class CourseNotFound extends DomainError("CourseNotFound", { fields: { courseId: Schema.String }, kind: "not_found" }) {}
class CourseFull extends DomainError("CourseFull", { fields: { courseId: Schema.String, capacity: Schema.Int }, kind: "conflict" }) {}

// 3. A command: a PURE decision. Nothing here touches a database.
const Subscribe = defineCommand({
  name: "subscribe",
  errors: [CourseNotFound, CourseFull], // the domain errors it can fail with; `decide` may fail with no others
  input: Schema.Struct({ studentId: Schema.String, courseId: Schema.String }),
  model: (c) => CourseModel.of({ id: c.courseId }),
  decide: (course, c) =>
    !course.exists
      ? fail(new CourseNotFound({ courseId: c.courseId }))
      : course.subscribers >= course.capacity
        ? fail(new CourseFull({ courseId: c.courseId, capacity: course.capacity }))
        : emit(StudentSubscribed(c))
});
```

A note on the ids: the tutorial uses readable ids (`ann`, `math-101`) so the examples are easy to follow. In a real system, put **opaque ids** in events and
tags (`student_7f3a...`), and keep names, emails and other personal data out of tags altogether: tags are stored as plain, indexed text and cannot be erased or
redacted. Mark such fields once with `personal(...)` (from `@crablet/commands/Personal`) wherever they appear in an event or a command input, and the framework
redacts them in the command audit and flags them in the API description; building an event whose tag repeats a personal value fails.

Three things to notice:

- `decide` is a **pure function** of the state and the input. It either returns `emit(...)` events or `fail(...)` with a typed error.
- The model's **boundary** - "which events could change this answer" - is derived from the events it handles. You never write a query.
- A command lists the **domain errors** it can fail with in `errors`. `decide` cannot fail with a domain error that is not listed
  (the compiler tells you which one is missing). Step 3 uses that list to document the API.

**A test** - given a history, when a command arrives, then...:

<!-- file: examples/course-enrolment-app/tutorial/step1-capacity-only.test.ts#step1-tests -->
```ts
// 4. Test it: given a history, when a command arrives, then ... (the real command pipeline, against an in-memory store).
describe("step 1: a course holds at most `capacity` students", () => {
  test("a student subscribes to a course with a free seat", async () => {
    const scenario = given(CourseDefined({ courseId: "math", capacity: 2 }));
    const result = await scenario.when(Subscribe, { studentId: "ann", courseId: "math" });
    expect(result.outcome).toBe("created");
    expect(result.events.map((e) => e.type)).toEqual(["StudentSubscribed"]);
  });

  test("the last seat goes to whoever asks first; the next student is refused with CourseFull", async () => {
    const scenario = given(CourseDefined({ courseId: "math", capacity: 1 }));
    expect((await scenario.when(Subscribe, { studentId: "ann", courseId: "math" })).outcome).toBe("created");
    const refused = await scenario.when(Subscribe, { studentId: "bob", courseId: "math" });
    expect(refused.error).toBeInstanceOf(CourseFull);
    expect(refused.events).toEqual([]); // nothing was written
  });

  test("an unknown course is refused", async () => {
    const result = await given().when(Subscribe, { studentId: "ann", courseId: "ghost" });
    expect(result.error).toBeInstanceOf(CourseNotFound);
  });
});
```

Run it (from the repository root):

```bash
bun test examples/course-enrolment-app/tutorial/step1-capacity-only.test.ts
```

```
 3 pass
 0 fail
```

`given(...)` runs the **real** command pipeline - input validation, loading the model, `decide`, the conditional append - against an
in-memory store that behaves like the Postgres one (a conformance suite checks that). What it cannot show is concurrency: nothing
interleaves in memory. That is step 2.

---

## Step 2 - Postgres, and the second rule

Everything from here lives in the example package:

```bash
cd examples/course-enrolment-app
docker compose up -d      # a Postgres 18 on localhost:5432 (database courses_db, user and password postgres)
node src/migrate.ts       # creates the framework's tables and this app's own. Run it ONCE per fresh database
```

```
Migrations applied.
```

The domain in `src/domain/Enrolment.ts` is the **final** one: step 1's rule plus the student limit. This is the DCB moment - compare
with step 1. The events and models now look at each other from two sides:

<!-- file: examples/course-enrolment-app/src/domain/Enrolment.ts#events -->
```ts
export const CourseDefined = defineEvent("CourseDefined", {
  schema: Schema.Struct({ courseId: Schema.String, capacity: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)) }),
  tags: (d) => ({ course_id: d.courseId })
});

// One fact, tagged with BOTH the student and the course it concerns.
export const StudentSubscribed = defineEvent("StudentSubscribed", {
  schema: Schema.Struct({ studentId: Schema.String, courseId: Schema.String }),
  tags: (d) => ({ student_id: d.studentId, course_id: d.courseId })
});
```

<!-- file: examples/course-enrolment-app/src/domain/Enrolment.ts#models -->
```ts
// Two models over the SAME events, looked at from two sides.
export const CourseModel = defineModel({
  by: "course_id",
  initial: () => ({ exists: false, capacity: 0, subscribers: 0 })
})
  .on(CourseDefined, (c, d) => ({ ...c, exists: true, capacity: d.capacity }))
  .on(StudentSubscribed, (c) => ({ ...c, subscribers: c.subscribers + 1 }));

export const StudentModel = defineModel({ by: "student_id", initial: () => ({ courses: [] as ReadonlyArray<string> }) })
  .on(StudentSubscribed, (s, d) => ({ courses: [...s.courses, d.courseId] }));
```

A command has two parts. Its **contract** - its name, its input Schema and the domain errors it can fail with - is the public part. It lives in
`src/domain/enrolment.contract.ts` (the error classes too), and that file imports nothing that decides anything:

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

Its **behavior** - the model and `decide` - is the private part. You add it by spreading the contract into `defineCommand`, the same function as in step 1; the contract
is only where the name, the input and the errors now come from. From step 3 the HTTP API is declared from contracts alone, and so is the page in step 5, so a
browser can import them without receiving the rules (a test fails if the contract module ever reaches a server-only module). The command decides on **both** the course and the student at once:

<!-- file: examples/course-enrolment-app/src/domain/Enrolment.ts#subscribe -->
```ts
export const Subscribe = defineCommand({
  ...SubscribeContract,
  // The boundary is the union of the course's events and the student's events.
  model: (c) => all({ course: CourseModel.of({ id: c.courseId }), student: StudentModel.of({ id: c.studentId }) }),
  decide: ({ course, student }, c) =>
    !course.exists
      ? fail(new CourseNotFound({ courseId: c.courseId }))
      : student.courses.includes(c.courseId)
        ? noop("ALREADY_SUBSCRIBED")
        : course.subscribers >= course.capacity
          ? fail(new CourseFull({ courseId: c.courseId, capacity: course.capacity }))
          : student.courses.length >= MAX_COURSES_PER_STUDENT
            ? fail(new StudentAtLimit({ studentId: c.studentId, limit: MAX_COURSES_PER_STUDENT }))
            : emit(StudentSubscribed(c))
});
```

Adding the second rule was: a second model, `all({ course, student })` instead of one model, and one more branch in `decide`. Nothing was
redesigned. The consistency boundary of `subscribe` is now *the course's events plus the student's events*: a subscription by anyone to
this course, or by this student to any course, invalidates a decision made on stale state, and the command is re-run with fresh state.

Now run the **same** commands against the real database:

```bash
node scripts/step2-postgres.ts
```

```
two students race for the last seat: subscribed, CourseFull
one student subscribes to four courses: subscribed, subscribed, subscribed, StudentAtLimit
```

The first line is two students asking for the last seat at the same moment: exactly one is subscribed, the other is refused with
`CourseFull` - after the framework noticed that its decision was made on stale state and re-ran it. (The order of the two words may differ.)
The second is a student's fourth course being refused. The code behind the race is short:

<!-- file: examples/course-enrolment-app/src/step2Demo.ts#step2-race -->
```ts
// Rule 1: a course holds at most `capacity` students. Two students race for the LAST seat.
yield* executor.run(DefineCourse, { courseId: `physics-${id}`, capacity: 1 });
const lastSeat = yield* Effect.all([subscribe(`ann-${id}`, `physics-${id}`), subscribe(`bob-${id}`, `physics-${id}`)], { concurrency: 2 });
log(`two students race for the last seat: ${lastSeat.join(", ")}`);
```

This demo races naturally, so the guarantee it shows is "exactly one winner". The framework's own tests *force* the overlap (every racer
loads its state before any appends) for this same domain: see
[`enrolment-guide-postgres.test.ts`](../../packages/commands/test/integration/enrolment-guide-postgres.test.ts), and the
[DCB guide](../dcb-guide.md) for the theory.

---

## Step 3 - an HTTP API, and its OpenAPI description

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

The route is the contract's `name`. Because the list keeps its contracts' literal names, the API's *type* has one endpoint per command: a client derived from it knows that
`subscribe` takes `{ studentId, courseId }` and can fail with `CourseNotFound`, `CourseFull` or `StudentAtLimit`. Annotating the list as `ReadonlyArray<...>` still works, but it forgets the names and the
client falls back to a single, loosely typed endpoint. The server hands the matching *commands* to the same API, one per contract:

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

### The OpenAPI description

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

## Step 4 - read your own writes

Projections are updated asynchronously, a moment after the write. A client that subscribes a student and immediately asks "how many seats
are left?" could see the old answer. Add a **view** - a table kept up to date by a small projector:

<!-- file: examples/course-enrolment-app/src/views/CourseSeatsViewProjector.ts#projector -->
```ts
// Seats per course. Each event is applied once even if it is delivered again: the row remembers the position of the
// last event it applied, and an event at or before that position is ignored. That is sound here because the events that
// touch one course are written one after another (their commands share a boundary), so a course's positions only grow;
// for events of unrelated transactions, delivery order is not position order, so key idempotency on the event instead.
//
// `decodeStored` reads the payload through the event's own definition: one this definition cannot read fails the batch with a typed `EventDecodingError`
// (position, type, issues), which the processor records against the view, instead of projecting something wrong. Casting `event.data` would validate nothing.
const handleEvent = (event: StoredEvent, sql: SqlClient.SqlClient): Effect.Effect<void, SqlError | EventDecodingError, never> =>
  Effect.gen(function* () {
    switch (event.type) {
      case CourseDefined.type: {
        const data = yield* CourseDefined.decodeStored(event);
        yield* sql.unsafe(
          `INSERT INTO course_seats_view (course_id, capacity, subscribers, last_position) VALUES ($1, $2, 0, $3)
           ON CONFLICT (course_id) DO NOTHING`,
          [data.courseId, data.capacity, event.position.toString()]
        );
        return;
      }
      case StudentSubscribed.type: {
        const data = yield* StudentSubscribed.decodeStored(event);
        yield* sql.unsafe(
          `UPDATE course_seats_view SET subscribers = subscribers + 1, last_position = $2
           WHERE course_id = $1 AND last_position < $2`,
          [data.courseId, event.position.toString()]
        );
        return;
      }
      default:
        return;
    }
  });

export const makeCourseSeatsViewProjector = (): Effect.Effect<ViewProjector<SqlError | EventDecodingError>, never, SqlClient.SqlClient> =>
  makeTransactionalViewProjector(COURSE_SEATS_VIEW, handleEvent);
```

and a read endpoint over it. Reads are written by hand (their response schema is declared here; it is not derived from the domain):

<!-- file: examples/course-enrolment-app/src/api/CourseQueryApi.ts#query-api -->
```ts
// A read endpoint, hand-written: the response schema is declared here (reads are not derived from the domain model). Both reads take the
// consistency parameters (`consistentWith`, `consistency`, `waitTimeout`) and can answer 400 and 503 besides their own errors, and a
// client resolves each to `{ body, headers }` (`ReadSuccess`; the header marks a stale answer): see @crablet/views-http.
// Its 404 is the SAME problem the write API uses for CourseNotFound, so both appear as one component in the description.
export const CourseResponse = Schema.Struct({
  courseId: Schema.String,
  capacity: Schema.Int,
  subscribers: Schema.Int,
  seatsLeft: Schema.Int
});

// One page of courses, in course id order. `next` is the cursor of the following page, or null on the last one; pass it back as `after`.
export const CoursePage = Schema.Struct({
  items: Schema.Array(CourseResponse),
  next: Schema.NullOr(Schema.String)
});

export const defaultPageSize = 20;
export const maxPageSize = 100;

// Query values arrive as strings. They are plain strings here on purpose and validated by the handler (like the consistency parameters), so a bad
// value answers with the same problem body as every other 400 instead of the HTTP framework's empty-bodied default.
export const listCoursesQuery = {
  limit: Schema.optionalKey(
    Schema.String.annotate({ description: `How many courses to return: a whole number from 1 to ${maxPageSize} (default ${defaultPageSize}).` } as never)
  ),
  after: Schema.optionalKey(
    Schema.String.annotate({ description: "Return the courses after this cursor: the `next` of the previous page. Opaque to clients." } as never)
  ),
  q: Schema.optionalKey(
    Schema.String.annotate({ description: "Only courses whose id starts with this text (case-sensitive)." } as never)
  )
};

export const courseQueryGroup = HttpApiGroup.make("courseQueries")
  .add(
    HttpApiEndpoint.get("getCourse", "/api/courses/:courseId", {
      params: { courseId: Schema.String },
      query: consistencyQuery,
      success: ReadSuccess(CourseResponse),
      error: [problemSchemaOf(CourseNotFound), ...readProblems]
    })
  )
  .add(
    HttpApiEndpoint.get("listCourses", "/api/courses", {
      query: { ...listCoursesQuery, ...consistencyQuery },
      success: ReadSuccess(CoursePage),
      error: [...readProblems]
    })
  );
```

There are two reads. `GET /api/courses/{courseId}` is one course. `GET /api/courses` is a **page** of courses in id order: `?limit=` (1 to 100, default 20), `?after=` (the `next` of the previous page; an opaque cursor) and `?q=` (ids that start with the text). It is paginated by cursor, not by offset: a page costs the same however deep it is, and a course added meanwhile cannot shift the pages. A bad value is the same 400 problem as everywhere else.

```bash
curl -s 'localhost:8080/api/courses?limit=2'
curl -s 'localhost:8080/api/courses?q=phys'
```

The answer is `{ "items": [ ...the same shape as one course... ], "next": "<cursor>" | null }`; `next` is `null` on the last page. Both read the view; how fresh they are is the next section.

A write answers as soon as it has committed, with a **marker**: where in the log it ended (`"<transactionId>:<position>"`). Waiting belongs to the **read**: a
read can ask to include a write, and the server answers it only once the view has that write. This is the policy of the course reads (the HTTP package that does the
waiting, `@crablet/views-http`, is the only place that knows about both views and HTTP):

<!-- file: examples/course-enrolment-app/src/api/CourseQueryApiLive.ts#read-consistency -->
```ts
// How consistent the reads are (ADR-0015). The server default: strict, and a read with no marker waits for the head of the log, so a read made
// after a write includes it. A read that carries a write's marker (`?consistentWith=<marker>`) waits only for that write. If the seats view
// is not there in time the read is a 503, never a wrong answer. This app lets a client loosen a read (`clientMayRelax`):
// `?consistency=eventual` answers at once and may be stale, `?consistency=bounded` waits up to the timeout and then answers marked stale.
export const courseReadConsistency: ReadConsistencyConfig = { ...defaultReadConsistency, clientMayRelax: true };
const consistentRead = makeConsistentRead({ config: courseReadConsistency });
```

(The server you started already includes all of this: `startCourseViews()` runs the view processor, woken by Postgres `LISTEN/NOTIFY`.)
Define a course, subscribe a student, and read **once** after each - with no waiting code and no marker:

```bash
curl -s -X POST localhost:8080/api/commands/define_course \
  -H 'Content-Type: application/json' -d '{"courseId":"physics-201","capacity":3}'
curl -s localhost:8080/api/courses/physics-201

curl -s -X POST localhost:8080/api/commands/subscribe \
  -H 'Content-Type: application/json' -d '{"studentId":"dee","courseId":"physics-201"}'
curl -s localhost:8080/api/courses/physics-201
```

```
{"status":"CREATED","reason":null,"lastPosition":"13","lastTransactionId":"13","marker":"13:13"}
{"courseId":"physics-201","capacity":3,"subscribers":0,"seatsLeft":3}
{"status":"CREATED","reason":null,"lastPosition":"14","lastTransactionId":"14","marker":"14:14"}
{"courseId":"physics-201","capacity":3,"subscribers":1,"seatsLeft":2}
```

A read with no parameters waits for **everything committed when it arrived**, so it is never stale. Cases to know:

- **Carry the marker** to wait for just your write: `?consistentWith=14:14` (or `?consistentWith=latest`, which is what no parameter means here). Same guarantee for your own
  write, and it does not wait for unrelated writes that came after.
- **Ask not to wait** (this app lets a client loosen a read): `?consistency=eventual` answers at once with whatever the view has, so right after a write it may be stale.
  `?consistency=bounded` waits up to the timeout and then answers anyway, marked with the header `Crablet-Consistency: stale`.
- **The view did not catch up in time** (default 5 s, `?waitTimeout=<ms>` up to 30 s) on a strict read: a `503` problem with `Retry-After`, naming the views that are behind.
  It is never a stale answer: a strict read is either right or refused. (A view that is `FAILED` is a `503` too, without `Retry-After`: retrying will not help.)
- **A repeat** appended nothing, so its response has `"marker":null`; read with `latest`.
- **A bad marker**, or one beyond the end of the log, is a `400` *before* anything waits:

```bash
curl -s 'localhost:8080/api/courses/physics-201?consistentWith=nope'
```

```
{"type":"urn:crablet:problem:command-api:bad-request","title":"Bad Request","status":400,"detail":"consistentWith must be a marker from a command response (\"<transactionId>:<position>\") or \"latest\""}
```

The `consistentWith`, `consistency` and `waitTimeout` parameters, the stale header and the `503` are in the OpenAPI description too (run `node scripts/generate-openapi.ts` if you changed anything).

---

## Step 5 - a page that uses it

So far the only client was `curl`. A real client has to do three things the tutorial has only described: **send commands**, **understand refusals**, and
**read its own writes**. This step is a small web page for the same API, written with [Foldkit](https://foldkit.dev) (an Elm-style framework on Effect: a
Model, Messages, one `update` function, and Commands for side effects). It is not a Foldkit tutorial; it is what a client of this API sees, and it is one more
tested example (`examples/course-enrolment-ui`): the course app, unchanged, plus a page.

Restart the server with the seat map held back 400 ms. That is a demo knob (`COURSES_VIEW_DELAY_MS`, off by default): without it the view catches up in
milliseconds and you could not *see* what a read that carries a write's marker is for.

```bash
COURSES_VIEW_DELAY_MS=400 node src/index.ts
```

In another terminal start the page, then open <http://localhost:5173>:

```bash
cd ../course-enrolment-ui
bun run dev
```

Things to try:

1. **Define** a course `math` with capacity `1`, and **subscribe** `ann` to it. Each answer carries the write's `marker`, and the page reads the course back for you with it.
2. **Subscribe** `bob` to `math`: "Course math is full (1 seats, all taken)". That is `CourseFull` arriving with its `capacity`; the page did not parse a message.
3. Untick **Read back with my write's marker**, define `physics` and subscribe `cy` to it. The page now asks the server not to wait for the seat map (`?consistency=eventual`):
   the answer is instant, and the read-back is *stale*: the seats have not moved, or the course is "just written, but the seat map has not caught up". Tick the box again and
   the same actions give the right numbers: the page sends the marker with the read (`?consistentWith=<marker>`) and the server answers it once the seat map has that write.
4. Define `math` a second time, or a capacity of `0`, or subscribe a student to four courses. Every refusal is a different problem, shown in its own words.

### How it is built

**One origin.** The page and the API are separate servers, and the API has no CORS handling (see "What this showed"), so the dev server proxies the API:

<!-- file: examples/course-enrolment-ui/vite.config.ts#proxy -->
```ts
// The course API (examples/course-enrolment-app) listens on :8080. Proxying it makes the page and the API ONE origin in
// the browser, so the server needs no CORS handling. (To call the API on its own origin instead, set VITE_API_URL and start the
// server with COURSES_CORS_ORIGINS=<this page's origin>; see src/api.ts.)
const api = `http://localhost:${process.env["PORT"] ?? 8080}`;

export default defineConfig({
  // one copy of effect: the page and the course app's API definition (imported below) must share its Schema classes
  resolve: { dedupe: ["effect"] },
  server: { proxy: { "/api": api, "/openapi.json": api } }
});
```

**The client is derived from the API definition**, not re-declared. `course-enrolment-app/CourseApi` is the module the server serves (routes, request and response Schemas,
the domain errors); the page builds its client from it with `HttpApiClient.make(makeCourseApi())`. By default the URLs are relative, which works because the dev server proxies the API
(above). To call the API on another origin directly instead, set `VITE_API_URL` and let the server allow the page's origin (CORS is off unless asked for):

<!-- file: examples/course-enrolment-ui/src/api.ts#client -->
```ts
// Where the API is. Unset: relative URLs, which works when the page and the API share an origin (the Vite dev proxy does that, and so
// would serving the page from the API server). With VITE_API_URL set (for example http://localhost:8080) the page calls that origin
// directly, which needs CORS on the server (COURSES_CORS_ORIGINS=<the page's origin>, see @crablet/commands-http/Cors).
// `import.meta.env` is Vite's (and Bun's); under plain Node, as in the integration test, it is absent and the base is relative.
export const apiBaseUrl: string | undefined = (import.meta as unknown as { env?: { VITE_API_URL?: string } }).env?.VITE_API_URL || undefined;
const makeClient = () => HttpApiClient.make(makeCourseApi(), apiBaseUrl === undefined ? {} : { baseUrl: apiBaseUrl });
```

```bash
# the server (examples/course-enrolment-app): allow the page's origin
COURSES_CORS_ORIGINS=http://localhost:5173 node src/index.ts
# the page (examples/course-enrolment-ui): call the API directly, no proxy
VITE_API_URL=http://localhost:8080 bun run dev
```

Because the list of contracts in step 3 kept its names, the client is typed
*per command*: `execute_subscribe` takes exactly `{ studentId, courseId }` (a misspelled field does not compile), and fails with exactly the problems `subscribe` declares, plus
the transport's error and a Schema error. No cast, no copy of the wire format:

<!-- file: examples/course-enrolment-ui/src/api.ts#call -->
```ts
// The calls are plain methods of the derived client: `execute_<command>` takes that command's own payload (a misspelled
// field does not compile) and fails with exactly the problems that command declares, plus the transport's and the Schema's.
// A write does not wait for anything: it answers once it has committed, with the marker of what it wrote.
export const defineCourseCall = (courseId: string, capacity: number) =>
  Effect.gen(function* () {
    const client = yield* makeClient();
    const answer = yield* client.commands.execute_define_course({ payload: { courseId, capacity } });
    return outcomeOf(answer);
  });

export const subscribeCall = (studentId: string, courseId: string) =>
  Effect.gen(function* () {
    const client = yield* makeClient();
    const answer = yield* client.commands.execute_subscribe({ payload: { studentId, courseId } });
    return outcomeOf(answer);
  });

// How a read asks to be consistent. With nothing, the server's default applies (this app: a read waits for everything committed when it arrived).
// `consistentWith` is a write's marker (the read waits for that write) or `latest`; either way the server answers only once the seat map has
// it, or with a 503 if it cannot in time. `eventual` asks for no waiting at all: the answer may be stale, which is what the checkbox below shows.
export interface ReadConsistency {
  readonly consistentWith: string | null;
  readonly eventual?: boolean;
}
const consistencyOf = (read: ReadConsistency) => ({
  ...(read.consistentWith === null ? {} : { consistentWith: read.consistentWith }),
  ...(read.eventual === true ? { consistency: "eventual" } : {})
});

// One page of the course list. `after` is the previous page's `next`; `q` keeps ids that start with it. A read resolves to
// `{ body, headers }` (the header marks a stale answer, which this page never asks for): the page wants the body.
export const listCourses = (options: { readonly q: string; readonly after: string | null } & ReadConsistency) =>
  Effect.gen(function* () {
    const client = yield* makeClient();
    const answer = yield* client.courseQueries.listCourses({
      query: {
        ...(options.q === "" ? {} : { q: options.q }),
        ...(options.after === null ? {} : { after: options.after }),
        ...consistencyOf(options)
      }
    });
    return answer.body;
  });

export const getCourse = (courseId: string, read: ReadConsistency) =>
  Effect.gen(function* () {
    const client = yield* makeClient();
    const answer = yield* client.courseQueries.getCourse({ params: { courseId }, query: consistencyOf(read) });
    return answer.body;
  });

const outcomeOf = (answer: { readonly status: "CREATED" | "IDEMPOTENT"; readonly reason: string | null; readonly marker: string | null }): CommandOutcome => ({
  status: answer.status,
  reason: answer.reason,
  marker: answer.marker
});
```

**A refusal is data, and the compiler checks you handled it.** A domain error's problem body carries its `errorType` and its declared `fields`, typed exactly. `problemFromError`
matches on them; the `never` in the last case means that if the server's command gains a new declared error and the page has no case for it, the page stops compiling:

<!-- file: examples/course-enrolment-ui/src/api.ts#problems -->
```ts
export const Problem = Schema.Union([
  Schema.TaggedStruct("CourseNotFound", { courseId: Schema.String }),
  Schema.TaggedStruct("CourseFull", { courseId: Schema.String, capacity: Schema.Int }),
  Schema.TaggedStruct("StudentAtLimit", { studentId: Schema.String, limit: Schema.Int }),
  // The framework's own refusals: a 400 (the input did not parse) and a 409 (for example, a course that already exists).
  Schema.TaggedStruct("Rejected", { title: Schema.String, detail: Schema.String }),
  // The derived client checks a request against the API's own Schema BEFORE sending it, and checks the answer against the
  // response Schema; either failure is a SchemaError whose message names the field (`at ["capacity"]`). (The server's own 400
  // names the failing fields too, in its `errors` member, for clients that do not validate first.)
  Schema.TaggedStruct("Mismatch", { detail: Schema.String }),
  // Not from the server: the page's reading of a "no such course" it just wrote itself (the seat map lags behind writes).
  Schema.TaggedStruct("NotInSeatMapYet", { courseId: Schema.String }),
  // A read that asked to include a write was refused (503): the seat map had not caught up in time (try again), or is not updating at all.
  Schema.TaggedStruct("SeatMapBehind", { failed: Schema.Boolean }),
  Schema.TaggedStruct("Unreachable", {})
]);
export type Problem = typeof Problem.Type

// Everything a call above can fail with. These are the TYPES the derived client reports, not guesses: a domain error's problem
// body (told apart by `errorType`, with exactly the `fields` that error declares), the framework's 400/409/500 problems, the
// transport's error and a SchemaError.
export type CallError =
  | Effect.Error<ReturnType<typeof defineCourseCall>>
  | Effect.Error<ReturnType<typeof subscribeCall>>
  | Effect.Error<ReturnType<typeof getCourse>>
  | Effect.Error<ReturnType<typeof listCourses>>;

export const problemFromError = (error: CallError): Problem => {
  if ("errorType" in error) {
    switch (error.errorType) {
      case "CourseNotFound":
        return { _tag: "CourseNotFound", courseId: error.fields.courseId };
      case "CourseFull":
        return { _tag: "CourseFull", courseId: error.fields.courseId, capacity: error.fields.capacity };
      case "StudentAtLimit":
        return { _tag: "StudentAtLimit", studentId: error.fields.studentId, limit: error.fields.limit };
      default: {
        // a new declared error with no case above does not compile: `error` would not be `never`
        const unhandled: never = error;
        return unhandled;
      }
    }
  }
  if (Schema.isSchemaError(error)) return { _tag: "Mismatch", detail: error.message };
  // the 503 a read answers when the seat map cannot catch up to the write it was asked to include (told apart by its `reason`)
  if ("reason" in error && "views" in error) return { _tag: "SeatMapBehind", failed: error.reason === "view_failed" };
  if ("title" in error) {
    // a 400 for a body that did not match the input says which fields (`errors`), by path
    const fields = "errors" in error && error.errors !== undefined ? error.errors.map((issue) => `${issue.path.join(".") || "(body)"}: ${issue.message}`).join("; ") : "";
    return { _tag: "Rejected", title: error.title, detail: fields === "" ? error.detail : `${error.detail} (${fields})` };
  }
  return { _tag: "Unreachable" };
};
```

**A Command ends in a Message, never an exception.** It runs one call and turns the answer, success or any refusal, into a Message that `update` matches on:

<!-- file: examples/course-enrolment-ui/src/main.ts#command -->
```ts
export const SubscribeStudent = Command.define("SubscribeStudent", {
  args: { studentId: Schema.String, courseId: Schema.String },
  messages: [Message.SucceededSubscribe, Message.FailedSubscribe],
  execute: ({ studentId, courseId }) =>
    subscribeCall(studentId, courseId).pipe(
      Effect.map((outcome) => Message.SucceededSubscribe({ studentId, courseId, outcome })),
      Effect.catch((error) => Effect.succeed(Message.FailedSubscribe({ problem: problemFromError(error) }))),
      Effect.provide(Http.layer)
    )
});
```

**Reading your own write.** A write does not wait for anything: it answers once it has committed, with a `marker`. The page's read-back carries that marker
(`?consistentWith=<marker>`) unless you untick the box, in which case it asks not to wait (`?consistency=eventual`); the server answers a read that has a marker only once the seat map
has the write, or refuses it with a `503` if it cannot in time (the page shows that as "the seat map has not caught up with your write yet"); and the page says which read it made:

<!-- file: examples/course-enrolment-ui/src/main.ts#read-back-note -->
```ts
// What the page says about the read it made after a write. With the write's marker the server answered only once the seat map had the write
// (or refused: see `SeatMapBehind`), so the numbers include it; a write that appended nothing (an idempotent repeat) has no marker, so the read
// asked for `latest`; with the checkbox off the read asked not to wait and may be stale.
export const readBackNote = (readBack: ReadBack): string => {
  switch (readBack) {
    case "with_marker":
      return "Read back with this write's marker, so the numbers below include it.";
    case "latest":
      return "Nothing was written, so there is no marker; the read waited for everything committed so far, so the numbers below include any earlier write.";
    case "eventual":
      return "Read back without waiting for the seat map, so the numbers below may be stale.";
  }
};
```

### Testing it

`update` is a pure function, so a *story* (Messages in, Model and Commands out, Commands resolved inline) tests it without a browser or a server, and a *scene* drives the real view like
a user would. Both run under `bun test`:

```bash
bun test examples/course-enrolment-ui/test/page.test.ts
```

The integration test goes further. A ten-line driver plays Foldkit's runtime against the **real course app on Postgres**: it feeds a Message to the page's own `update`, runs every
Command it returns (the real derived client, a real `fetch`), feeds the results back, and stops when nothing is left. What it ends with is the Model the page would be showing.

<!-- file: examples/course-enrolment-ui/test/integration/page-against-server.test.ts#driver -->
```ts
// Feed `messages` through the page one after another, running every Command to completion in between.
const drive = async (from: Model, ...messages: ReadonlyArray<Message>): Promise<Model> => {
  let model = from;
  const queue: Array<Message> = [...messages];
  while (queue.length > 0) {
    const result = update(model, queue.shift()!);
    model = result.model;
    for (const command of result.commands ?? []) queue.unshift((await Effect.runPromise(command.effect as Effect.Effect<Message>)) as Message);
  }
  return model;
};
```

It asserts the interesting cases: a read-back without the marker is stale, one with it is right (and really waits), a read the seat map cannot serve in time is the `503` the page understands, every refusal arrives as the problem the page expects, and an unreachable server is reported as such
(`node --test examples/course-enrolment-ui/test/integration/page-against-server.test.ts`, needs Docker).

### What this showed

Building a client is the quickest way to find what an API is missing. Each of these is a real finding, not a to-do for this page:

- **A view is not the truth.** "There is no course called X" right after "Defined course X" is true of the seat map and false of the course. The page treats an error from a view as being about the view.
- **The command client is typed per command** only while the list of contracts keeps its literal names (step 3): annotate the list as `ReadonlyArray<...>` and the client falls back to one loosely typed endpoint.
- **The derived client validates requests with the server's own Schema** before sending, and its error names the field (`capacity`), so this page never sees the server's 400 for a bad payload. A client that does
  not validate first (curl, another language, a generated client) gets the same information from the server: the 400 problem lists every failing field in `errors`, with a path and the check's message.
- **CORS is opt-in.** `commands-http` sends no CORS header unless the app adds `corsLayer({ allowedOrigins })`; it refuses an empty list (Effect's own middleware reads that as "every origin") and credentials with `"*"`. A page behind a proxy or served by the API needs none.
- **A list is just another read of the view**: `GET /api/courses` is a keyset-paginated page with an id-prefix filter, hand-written like the single read (no query engine; two apps do not justify one). The page loads it at startup, reloads it after every write (under the same wait setting as the read-back), filters by prefix, pages with "More" and opens a course with a click.
- **No live updates**: a second tab does not see a subscription until it reads. Views are asynchronous and there is no push channel.

---

### Live updates (a second tab)

Open the page in two browser tabs. Define a course in one: the other's list gets it without a reload. The write's marker (`?consistentWith`) is for *the tab that wrote*; the
other tab learns by a **ping**. Each progress step of a view sends a Postgres `NOTIFY` after it commits, the server turns it into a server-sent event on
`GET /api/views/changes?views=course-seats-view`, and the page's Foldkit *Subscription* turns each event into a Message (`ReceivedSeatMapPing`) that makes
`update` read the list again. The ping carries no data, only "the seat map moved", so the page always asks the API and a missed ping costs nothing: every
(re)connection starts with one. If the connection drops, the page says so and reconnects with a growing delay (0.5 s, doubling, at most 30 s). The code is the
`subscriptions` in `main.ts` and `reconnecting` in `api.ts`; `test/integration/page-against-server.test.ts` runs the two-tab case against the real server.

## Clean up, and where next

Stop the server and the page (Ctrl-C) and remove the database:

```bash
docker compose down -v
```

- The **wallet example** ([`examples/wallet-example-app`](../../examples/wallet-example-app)) is this at full size: five commands, four views, an automation, an
  outbox, statement periods.
- [ADR-0010](../adr/0010-declarative-command-api.md) explains the command API; [ADR-0011](../adr/0011-http-api-from-the-domain-model.md) the HTTP one.
- The [DCB guide](../dcb-guide.md) works through a transfer and this same enrolment example in more depth, including how the append conditions map onto the
  [DCB specification](https://dcb.events/specification/).
