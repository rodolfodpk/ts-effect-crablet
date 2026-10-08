# Step 4 - read your own writes

[← Step 3 - an HTTP API](03-an-http-api.md) · [Tutorial index](README.md) · [Step 5 - a page that uses it →](05-a-page-that-uses-it.md)

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

**You now have** a read model fed by a poller, and reads that wait for your write's marker (or for the head of the log), so a client reads its own write.

[← Step 3 - an HTTP API](03-an-http-api.md) · [Tutorial index](README.md) · [Step 5 - a page that uses it →](05-a-page-that-uses-it.md)
