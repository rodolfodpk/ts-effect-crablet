# Tutorial: course enrolment, from an in-memory test to an HTTP API

You will build a small service where **a course holds at most N students** and **a student takes at most 3 courses**. Those two
rules concern two different kinds of thing, yet they are decided together, atomically, without a saga and without picking an
"aggregate" first. That is what *dynamic consistency boundaries* (DCB) are for.

In four steps (about 30 minutes) you will:

1. write and test the rule **in memory** - no database, no Docker;
2. run it against **Postgres**, add the second rule, and watch two races resolve;
3. expose it as an **HTTP API** whose **OpenAPI** description is generated from your code;
4. add a **read model** and use `?waitFor=` so a client reads its own write.

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

And the command decides on **both** at once:

<!-- file: examples/course-enrolment-app/src/domain/Enrolment.ts#subscribe -->
```ts
export const Subscribe = defineCommand({
  name: "subscribe",
  errors: [CourseNotFound, CourseFull, StudentAtLimit],
  input: Schema.Struct({ studentId: Schema.String, courseId: Schema.String }),
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

Exposing a command is one line each. Nothing else about HTTP is written:

<!-- file: examples/course-enrolment-app/src/CourseApp.ts#expose -->
```ts
// The write API: one route per command, POST /api/commands/<name>. A command's declared `errors` are what the API
// presents (status from each error's kind) and documents; there is no HTTP code to write per command.
const courseCommands: Readonly<Record<string, ExposedCommand<any, any>>> = {
  define_course: exposedCommandOf(DefineCourse),
  subscribe: exposedCommandOf(Subscribe)
};
```

Start the server (add `COURSES_DOCS=scalar` to also serve a documentation page at `/docs`):

```bash
COURSES_DOCS=scalar node src/index.ts
```

In another terminal. Define a course and subscribe a student (the `lastPosition` numbers will differ on your machine):

```bash
curl -si -X POST localhost:8080/api/commands/define_course \
  -H 'Content-Type: application/json' -d '{"courseId":"math-101","capacity":2}'
```

```
HTTP/1.1 201 Created
content-type: application/json

{"status":"CREATED","reason":null,"lastPosition":"10"}
```

```bash
curl -s -X POST localhost:8080/api/commands/subscribe \
  -H 'Content-Type: application/json' -d '{"studentId":"ann","courseId":"math-101"}'
curl -s -X POST localhost:8080/api/commands/subscribe \
  -H 'Content-Type: application/json' -d '{"studentId":"ann","courseId":"math-101"}'
```

```
{"status":"CREATED","reason":null,"lastPosition":"11"}
{"status":"IDEMPOTENT","reason":"ALREADY_SUBSCRIBED","lastPosition":null}
```

The second call is a repeat: `200` and "already done", with nothing written. Now fill the course and ask for a third seat:

```bash
curl -s -X POST localhost:8080/api/commands/subscribe \
  -H 'Content-Type: application/json' -d '{"studentId":"bob","courseId":"math-101"}'
curl -si -X POST localhost:8080/api/commands/subscribe \
  -H 'Content-Type: application/json' -d '{"studentId":"cy","courseId":"math-101"}'
```

```
{"status":"CREATED","reason":null,"lastPosition":"12"}
HTTP/1.1 409 Conflict
content-type: application/problem+json

{"type":"urn:crablet:problem:command-api:conflict","title":"Conflict","status":409,"detail":"CourseFull","errorType":"CourseFull","fields":{"courseId":"math-101","capacity":2}}
```

The refusal is an RFC 7807 problem. You wrote no code for it: the status comes from the error's `kind` (`conflict` -> 409,
`not_found` -> 404), the body carries the error's own fields, and the response is `application/problem+json`. A payload that does not
match the command's input is a 400 problem, and defining a course twice is the framework's 409:

```bash
curl -s -X POST localhost:8080/api/commands/define_course \
  -H 'Content-Type: application/json' -d '{"courseId":"x","capacity":0}'
curl -s -X POST localhost:8080/api/commands/subscribe \
  -H 'Content-Type: application/json' -d '{"studentId":"ann","courseId":"ghost"}'
```

```
{"type":"urn:crablet:problem:command-api:bad-request","title":"Bad Request","status":400,"detail":"Invalid payload for command: define_course"}
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
// last event it applied, and an event at or before that position is ignored.
const handleEvent = (event: StoredEvent, sql: SqlClient.SqlClient): Effect.Effect<void, SqlError, never> => {
  switch (event.type) {
    case CourseDefined.type: {
      const data = CourseDefined.decode(event.data);
      return Effect.asVoid(
        sql.unsafe(
          `INSERT INTO course_seats_view (course_id, capacity, subscribers, last_position) VALUES ($1, $2, 0, $3)
           ON CONFLICT (course_id) DO NOTHING`,
          [data.courseId, data.capacity, event.position.toString()]
        )
      );
    }
    case StudentSubscribed.type: {
      const data = StudentSubscribed.decode(event.data);
      return Effect.asVoid(
        sql.unsafe(
          `UPDATE course_seats_view SET subscribers = subscribers + 1, last_position = $2
           WHERE course_id = $1 AND last_position < $2`,
          [data.courseId, event.position.toString()]
        )
      );
    }
    default:
      return Effect.void;
  }
};

export const makeCourseSeatsViewProjector = (): Effect.Effect<ViewProjector<SqlError>, never, SqlClient.SqlClient> =>
  makeTransactionalViewProjector(COURSE_SEATS_VIEW, handleEvent);
```

and a read endpoint over it. Reads are written by hand (their response schema is declared here; it is not derived from the domain):

<!-- file: examples/course-enrolment-app/src/api/CourseQueryApi.ts#query-api -->
```ts
// A read endpoint, hand-written: the response schema is declared here (reads are not derived from the domain model).
// Its 404 is the SAME problem the write API uses for CourseNotFound, so both appear as one component in the description.
export const CourseResponse = Schema.Struct({
  courseId: Schema.String,
  capacity: Schema.Int,
  subscribers: Schema.Int,
  seatsLeft: Schema.Int
});

export const courseQueryGroup = HttpApiGroup.make("courseQueries").add(
  HttpApiEndpoint.get("getCourse", "/api/courses/:courseId", {
    params: { courseId: Schema.String },
    success: CourseResponse,
    error: problemSchemaOf(CourseNotFound) as never
  })
);
```

Then tell the API which views a write request may wait for. This map is the whole connection (the HTTP package never imports the views package):

<!-- file: examples/course-enrolment-app/src/CourseApp.ts#wait-for -->
```ts
// The views a write request may wait for (`?waitFor=course-seats-view`): the response is then sent only once that view has
// processed the write, so the caller's next read is not stale. commands-http never imports the views package; this
// map is the whole connection.
const courseViewWaiters: Readonly<Record<string, ViewWaiter>> = {
  [COURSE_SEATS_VIEW]: (write, { timeout }) => waitUntilProcessed(courseSeatsViewSubscription, write, { timeout })
};
```

(The server you started already includes all of this: `startCourseViews()` runs the view processor, woken by Postgres `LISTEN/NOTIFY`.)
Now subscribe with `?waitFor=` and read **once**:

```bash
curl -s -X POST 'localhost:8080/api/commands/define_course?waitFor=course-seats-view' \
  -H 'Content-Type: application/json' -d '{"courseId":"physics-201","capacity":3}'
curl -s localhost:8080/api/courses/physics-201

curl -s -X POST 'localhost:8080/api/commands/subscribe?waitFor=course-seats-view' \
  -H 'Content-Type: application/json' -d '{"studentId":"dee","courseId":"physics-201"}'
curl -s localhost:8080/api/courses/physics-201
```

```
{"status":"CREATED","reason":null,"lastPosition":"13","view":{"name":"course-seats-view","caughtUp":true}}
{"courseId":"physics-201","capacity":3,"subscribers":0,"seatsLeft":3}
{"status":"CREATED","reason":null,"lastPosition":"14","view":{"name":"course-seats-view","caughtUp":true}}
{"courseId":"physics-201","capacity":3,"subscribers":1,"seatsLeft":2}
```

The response is sent only after the view has processed the write, so the read that follows is not stale. `view.caughtUp` says so. Cases to know:

- **The view did not catch up in time** (default wait 5 s, `?waitTimeout=<ms>` up to 30 s): the write still succeeded, so the response stays `201`
  and says `"caughtUp":false,"reason":"timeout"` (or `view_failed`, `unavailable`). It is never an error status: retrying a command that succeeded would be wrong.
- **A repeat** appended nothing, so there is nothing to wait for: `"reason":"nothing_appended"`.
- **An unknown view name** is a `400` *before* the command runs, so nothing is written. The message lists the views you can wait for.

```bash
curl -s -X POST 'localhost:8080/api/commands/subscribe?waitFor=nope' \
  -H 'Content-Type: application/json' -d '{"studentId":"dee","courseId":"physics-201"}'
```

```
{"type":"urn:crablet:problem:command-api:bad-request","title":"Bad Request","status":400,"detail":"Unknown view for waitFor: nope (one of: course-seats-view)"}
```

The `waitFor` and `waitTimeout` parameters are in the OpenAPI description too (run `node scripts/generate-openapi.ts` if you changed anything).

---

## Clean up, and where next

Stop the server (Ctrl-C) and remove the database:

```bash
docker compose down -v
```

- The **wallet example** ([`examples/wallet-example-app`](../../examples/wallet-example-app)) is this at full size: five commands, four views, an automation, an
  outbox, statement periods.
- [ADR-0010](../adr/0010-declarative-command-api.md) explains the command API; [ADR-0011](../adr/0011-http-api-from-the-domain-model.md) the HTTP one.
- The [DCB guide](../dcb-guide.md) works through a transfer and this same enrolment example in more depth, including how the append conditions map onto the
  [DCB specification](https://dcb.events/specification/).
