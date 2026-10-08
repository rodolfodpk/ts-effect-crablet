# Step 5 - a page that uses it

[← Step 4 - read your own writes](04-read-your-own-writes.md) · [Tutorial index](README.md) · [Clean up, and where next →](where-next.md)

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

## How it is built

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

## Testing it

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

## What this showed

Building a client is the quickest way to find what an API is missing. Each of these is a real finding, not a to-do for this page:

- **A view is not the truth.** "There is no course called X" right after "Defined course X" is true of the seat map and false of the course. The page treats an error from a view as being about the view.
- **The command client is typed per command** only while the list of contracts keeps its literal names (step 3): annotate the list as `ReadonlyArray<...>` and the client falls back to one loosely typed endpoint.
- **The derived client validates requests with the server's own Schema** before sending, and its error names the field (`capacity`), so this page never sees the server's 400 for a bad payload. A client that does
  not validate first (curl, another language, a generated client) gets the same information from the server: the 400 problem lists every failing field in `errors`, with a path and the check's message.
- **CORS is opt-in.** `commands-http` sends no CORS header unless the app adds `corsLayer({ allowedOrigins })`; it refuses an empty list (Effect's own middleware reads that as "every origin") and credentials with `"*"`. A page behind a proxy or served by the API needs none.
- **A list is just another read of the view**: `GET /api/courses` is a keyset-paginated page with an id-prefix filter, hand-written like the single read (no query engine; two apps do not justify one). The page loads it at startup, reloads it after every write (under the same wait setting as the read-back), filters by prefix, pages with "More" and opens a course with a click.
- **No live updates**: a second tab does not see a subscription until it reads. Views are asynchronous and there is no push channel.

---

## Live updates (a second tab)

Open the page in two browser tabs. Define a course in one: the other's list gets it without a reload. The write's marker (`?consistentWith`) is for *the tab that wrote*; the
other tab learns by a **ping**. Each progress step of a view sends a Postgres `NOTIFY` after it commits, the server turns it into a server-sent event on
`GET /api/views/changes?views=course-seats-view`, and the page's Foldkit *Subscription* turns each event into a Message (`ReceivedSeatMapPing`) that makes
`update` read the list again. The ping carries no data, only "the seat map moved", so the page always asks the API and a missed ping costs nothing: every
(re)connection starts with one. If the connection drops, the page says so and reconnects with a growing delay (0.5 s, doubling, at most 30 s). The code is the
`subscriptions` in `main.ts` and `reconnecting` in `api.ts`; `test/integration/page-against-server.test.ts` runs the two-tab case against the real server.

---

**You now have** a small Foldkit page that sends commands and marker reads through a typed client, and what a real client has to handle (refusals, a stale view, live updates).

[← Step 4 - read your own writes](04-read-your-own-writes.md) · [Tutorial index](README.md) · [Clean up, and where next →](where-next.md)
