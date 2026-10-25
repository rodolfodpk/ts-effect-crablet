# Add a view

*Guide · developers · the [tutorial](../../tutorial/README.md) · 15 minutes*

A view is a table kept up to date from events by a **projector**. It updates asynchronously. Delivery is at-least-once ([views and delivery](../../concepts/views-and-delivery.md)),
but a projector's writes commit in the same transaction as the view's cursor, so a batch handled twice is applied once, **as long as the writes go through the `sql` the
projector is given** ([ADR-0023](../../adr/0023-view-batch-and-cursor-in-one-transaction.md)). A projector that writes anywhere else (another database, a service) must still be
**idempotent**. The example is the course app's seat counter.

**Apply the change an event carries, not a total it recorded.** A commutative command (the wallet's deposit) does not wait for other deposits, so the balance it writes into its event is the balance it saw when it decided, and
a deposit that committed in between makes it stale (the kind lab counted 2,916 of 38,747 deposits that way in a two-hour soak, and 0 of 34,479 debits). A view that copies that number loses money; one that adds the amount
(`balance = balance + amount`) is right in any order. The wallet's balance view did copy it at first, and the kind lab's consistency check found 22 to 28 wallets wrong. For the same reason a `set` on a row that commuting events also write keeps the last one *delivered*: delivery follows causality, not the order unrelated commands decided in ([ordering](../../concepts/views-and-delivery.md#ordering)).

[← Task guides](../README.md)

## 1. Create the table

A migration of your own, numbered from `V100` so it cannot clash with the framework's: [`V100__course_seats_view.sql`](../../../examples/course-enrolment-app/db/migration/V100__course_seats_view.sql). List the file in
`appMigrationFiles` in [`migrate.ts`](../../../examples/course-enrolment-app/src/migrate.ts). The table does not need a column for "the last event applied": the batch and the view's cursor commit together, so the processor
applies each batch once ([V101](../../../examples/course-enrolment-app/db/migration/V101__course_seats_drop_last_position.sql) dropped the one this example used to keep). A projector that writes outside the given `sql` is the exception ([run it
in production](../operate/run-in-production.md)).

## 2. Declare the view

A view is a list of what each event does to its tables: `defineView(name, { tables }).on(Event, (data) => operations)` ([ADR-0026](../../adr/0026-views-declared-as-operations.md)). A handler is a pure function from the decoded event to
operations (`insert`, `update`, `upsert`, `remove`; `add` changes a column by an amount, which is the shape that keeps the view right in any order). The framework reads each payload through the event's own definition (an event it cannot read
fails the batch with a typed `EventDecodingError`, never projected wrongly), runs the operations on the `sql` of the view's cursor, and listens to the event types of your handlers. You declare the table once, with `viewTable`, as the migration made it.

<!-- file: examples/course-enrolment-app/src/views/CourseSeatsViewProjector.ts#projector -->
```ts
// The table, as the migration (db/migration/V100, V101) made it. `checkViewTables` compares this declaration with the migrated database (test/integration/course-seats-table.test.ts), so a column a migration renames fails a test.
export const courseSeatsTable = viewTable("course_seats_view", {
  key: { course_id: text() },
  columns: { capacity: integer(), subscribers: integer().default(0) }
});

// Seats per course: what each event does to the table, and nothing else. The handlers are pure (the decoded event in, operations out); the framework reads each payload through the event's own definition
// (a payload it cannot read fails the batch with a typed `EventDecodingError`, never projected wrongly), runs the operations on the `sql` of the view's cursor, and listens to the event types of the handlers
// below (CourseDefined, StudentSubscribed and SubscriptionReleased). `DefineCourse` refuses a second definition, and the insert also keeps the first capacity (`ignore`); a subscription ADDS one and a release takes one away, never copying a total.
// An event delivered twice is applied once, but not here: the batch and the view's cursor commit in one transaction (ADR-0023), so the processor guarantees it.
export const CourseSeatsView = defineView(COURSE_SEATS_VIEW, { tables: [courseSeatsTable] })
  .on(CourseDefined, (d) => courseSeatsTable.insert({ course_id: d.courseId, capacity: d.capacity }, { onConflict: "ignore" }))
  .on(StudentSubscribed, (d) => courseSeatsTable.update({ course_id: d.courseId }, { add: { subscribers: 1 } }))
  .on(SubscriptionReleased, (d) => courseSeatsTable.update({ course_id: d.courseId }, { add: { subscribers: -1 } }))
  // A cancelled course gives every seat back (each subscription ended with it).
  .on(CourseCancelled, (d) => courseSeatsTable.update({ course_id: d.courseId }, { set: { subscribers: 0 } }));
```

A test compares the declared table with the migrated database ([`course-seats-table.test.ts`](../../../examples/course-enrolment-app/test/integration/course-seats-table.test.ts), `checkViewTables`): a column a migration renames or retypes fails there,
not at the first event. And the same declaration runs in memory (`applyInMemory`, `@crablet/views/ViewMemory`), so a replayed history gives the rows a view must end with without a database.

### When the operations are not enough

`defineView` says six things: insert, update, upsert, remove, set, add (and `max`). For anything else (here, a number computed from the view's own rows, which is the highest seat number of the course plus one), a handler returns
`raw((sql) => ...)`: your own SQL, still in a `defineView`. The framework still reads the payload through the event's definition, runs your SQL on the `sql` of the view's cursor (so it commits with it, and the batch is applied
once), and takes the event types from the handlers. Declare the table anyway, so the drift check covers it. Nothing checks the SQL text, and `raw` cannot run in memory (`applyInMemory` refuses it), so write the test
([`course-enrolments-view.test.ts`](../../../examples/course-enrolment-app/test/integration/course-enrolments-view.test.ts)).
The course app registers it next to the seats view (`startCourseViews`, as in step 4) and reads it with `SqlSchema` (`GET /api/courses/:courseId/enrolments`, tested end to end in [`course-enrolments.test.ts`](../../../examples/course-enrolment-app/test/integration/course-enrolments.test.ts)), so this approach has a write and a query on the same view.

<!-- file: examples/course-enrolment-app/src/views/CourseEnrolmentsViewProjector.ts#hand-written -->
```ts
// The table, as the migration (db/migration/V102) made it, so the drift check covers it (test/integration/course-seats-table.test.ts).
export const courseEnrolmentsTable = viewTable("course_enrolments_view", {
  key: { course_id: text(), student_id: text() },
  columns: { seat_number: integer() }
});

// For what the table operations cannot say, `raw` runs your own SQL: the seat number a student gets is the highest of the course's seat numbers
// PLUS ONE (so a number given back by a release is not given again), computed by the database from the view's own table in the same statement. It runs
// on the `sql` of the view's cursor, so it commits with it (ADR-0023: the batch is applied once even if it is delivered twice); the payload is still read
// through the event's definition, and the view still listens to the event types of its handlers. Nothing checks the SQL text, and `raw` cannot run in
// memory: the integration test (test/integration/course-enrolments-view.test.ts) is what checks it. A release is a table operation (`remove`).
export const CourseEnrolmentsView = defineView(COURSE_ENROLMENTS_VIEW, { tables: [courseEnrolmentsTable] })
  .on(StudentSubscribed, (d) =>
    raw((sql) =>
      Effect.asVoid(
        sql.unsafe(
          `INSERT INTO course_enrolments_view (course_id, student_id, seat_number)
           SELECT $1::text, $2::text, COALESCE(max(seat_number), 0) + 1 FROM course_enrolments_view WHERE course_id = $1
           ON CONFLICT (course_id, student_id) DO NOTHING`,
          [d.courseId, d.studentId]
        )
      )
    )
  )
  .on(SubscriptionReleased, (d) => courseEnrolmentsTable.remove({ course_id: d.courseId, student_id: d.studentId }))
  // One row per student the cancellation was tagged with: a handler may return several operations.
  .on(CourseCancelled, (d) => d.studentIds.map((studentId) => courseEnrolmentsTable.remove({ course_id: d.courseId, student_id: studentId })));
```

The choice: **events that become adds, sets and removes: the table operations; anything else: `raw` SQL.** Either way it is one `defineView`. A query builder (Kysely, Drizzle) is optional and not used here: it would only replace the SQL string.

## 3. Say which events it wants

Nothing to write: the view listens to the event types of its handlers, so it cannot drift from what it does. What it reads besides them is declared with
it: the wallet's views read any event that names a wallet, `defineView(name, { tables, anyOfTags: WalletTags.ANY_WALLET })`, because a transfer names
its wallets as `from_wallet_id` and `to_wallet_id`.

## 4. Register it with the views processor

The views go to one processor. This is the wallet's, with four views (`walletViews`), and a per-view setting given by the view's name
(`walletViewOverrides`: polling and batch size are deployment settings, not part of the view). `startViewsProcessor` builds the processor and starts it, owned by the scope, which
stops it before the connection pool closes; a process that does not run the views role only builds it (`makeViewsProcessor`), for the admin API's status ([Run it in production](../operate/run-in-production.md#3-start-the-processors-serve-and-fail-loudly)).

<!-- file: examples/wallet-example-app/src/WalletApp.ts#views-processor -->
```ts
const views = { config: polling, views: walletViews, overrides: walletViewOverrides, instanceId, leader };
const viewsHandle = yield* (roles.has("views") ? startViewsProcessor(views) : makeViewsProcessor(views));
```

## 5. Read it

Reads that must include a write go through a consistent read: [tutorial step 4](../../tutorial/04-read-your-own-writes.md). Full reference for the package:
[`@crablet/views`](../../../packages/views/README.md).
