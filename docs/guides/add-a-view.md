# Add a view

A view is a table kept up to date from events by a **projector**. It updates asynchronously. Delivery is at-least-once ([reference](../reference.md#views-the-outbox-and-automations)),
but a projector's writes commit in the same transaction as the view's cursor, so a batch handled twice is applied once, **as long as the writes go through the `sql` the
projector is given** ([ADR-0023](../adr/0023-view-batch-and-cursor-in-one-transaction.md)). A projector that writes anywhere else (another database, a service) must still be
**idempotent**. The example is the course app's seat counter.

**Apply the change an event carries, not a total it recorded.** A commutative command (the wallet's deposit) does not wait for other deposits, so the balance it writes into its event is the balance it saw when it decided, and
a deposit that committed in between makes it stale (the kind lab counted 2,916 of 38,747 deposits that way in a two-hour soak, and 0 of 34,479 debits). A view that copies that number loses money; one that adds the amount
(`balance = balance + amount`) is right in any order. The wallet's balance view did copy it at first, and the kind lab's consistency check found 22 to 28 wallets wrong.

[← Task guides](README.md)

## 1. Create the table

A migration of your own, numbered from `V100` so it cannot clash with the framework's: [`V100__course_seats_view.sql`](../../examples/course-enrolment-app/db/migration/V100__course_seats_view.sql). List the file in
`appMigrationFiles` in [`migrate.ts`](../../examples/course-enrolment-app/src/migrate.ts). The table does not need a column for "the last event applied": the batch and the view's cursor commit together, so the processor
applies each batch once ([V101](../../examples/course-enrolment-app/db/migration/V101__course_seats_drop_last_position.sql) dropped the one this example used to keep). A projector that writes outside the given `sql` is the exception ([run it
in production](run-in-production.md)).

## 2. Declare the view

A view is a list of what each event does to its tables: `defineView(name, { tables }).on(Event, (data) => operations)` ([ADR-0026](../adr/0026-views-declared-as-operations.md)). A handler is a pure function from the decoded event to
operations (`insert`, `update`, `upsert`, `remove`; `add` changes a column by an amount, which is the shape that keeps the view right in any order). The framework reads each payload through the event's own definition (an event it cannot read
fails the batch with a typed `EventDecodingError`, never projected wrongly), runs the operations on the `sql` of the view's cursor and gives you the projector. You declare the table once, with `viewTable`, as the migration made it.

<!-- file: examples/course-enrolment-app/src/views/CourseSeatsViewProjector.ts#projector -->
```ts
// The table, as the migration (db/migration/V100, V101) made it. `checkViewTables` compares this declaration with the migrated database (test/integration/course-seats-table.test.ts), so a column a migration renames fails a test.
export const courseSeatsTable = viewTable("course_seats_view", {
  key: { course_id: text() },
  columns: { capacity: integer(), subscribers: integer().default(0) }
});

// Seats per course: what each event does to the table, and nothing else. The handlers are pure (the decoded event in, operations out); the framework reads each payload through the event's own definition
// (a payload it cannot read fails the batch with a typed `EventDecodingError`, never projected wrongly), runs the operations on the `sql` of the view's cursor, and takes the subscription's event types from
// the handlers below. A course defined twice keeps its first capacity (`ignore`); a subscription ADDS one, it never copies a total.
// An event delivered twice is applied once, but not here: the batch and the view's cursor commit in one transaction (ADR-0023), so the processor guarantees it.
export const CourseSeatsView = defineView(COURSE_SEATS_VIEW, { tables: [courseSeatsTable] })
  .on(CourseDefined, (d) => courseSeatsTable.insert({ course_id: d.courseId, capacity: d.capacity }, { onConflict: "ignore" }))
  .on(StudentSubscribed, (d) => courseSeatsTable.update({ course_id: d.courseId }, { add: { subscribers: 1 } }));

export const makeCourseSeatsViewProjector = (): Effect.Effect<ViewProjector<SqlError | EventDecodingError>, never, SqlClient.SqlClient> => CourseSeatsView.projector;
```

A test compares the declared table with the migrated database ([`course-seats-table.test.ts`](../../examples/course-enrolment-app/test/integration/course-seats-table.test.ts), `checkViewTables`): a column a migration renames or retypes fails there,
not at the first event. And the same declaration runs in memory (`applyInMemory`, `@crablet/views/ViewMemory`), so a replayed history gives the rows a view must end with without a database.

### When the operations are not enough

`defineView` says six things: insert, update, upsert, remove, set, add (and `max`). A view that needs anything else (here, a number computed from the view's own rows, which is the count of the course's rows plus one) is a **hand-written projector**: `makeTransactionalViewProjector`
with your own SQL, which is also what `raw((sql) => ...)` runs inside a declared view. You then do three things the framework did for you: read the payload with `decodeStored`, run the SQL on the `sql` you are given (so it commits with the view's cursor and the batch is applied once), and
write the subscription. Nothing checks the SQL text, so write the test ([`course-enrolments-view.test.ts`](../../examples/course-enrolment-app/test/integration/course-enrolments-view.test.ts)).

<!-- file: examples/course-enrolment-app/src/views/CourseEnrolmentsViewProjector.ts#hand-written -->
```ts
// A hand-written projector, for what `defineView`'s operations cannot say: the seat number a student gets is the count of the course's rows PLUS ONE, computed by the database from the view's own table in the
// same statement. You write the three things the framework would otherwise do: read the payload through the event's definition (`decodeStored`: an unreadable event fails the batch with a typed `EventDecodingError`),
// run the SQL on the `sql` you are given (so it commits with the view's cursor, ADR-0023: the batch is applied once even if it is delivered twice), and say which events you want (the subscription below).
// Nothing checks the SQL text; the integration test (test/integration/course-enrolments-view.test.ts) is what does.
const handleEvent = (event: StoredEvent, sql: SqlClient.SqlClient): Effect.Effect<void, SqlError | EventDecodingError, never> =>
  Effect.gen(function* () {
    if (event.type !== StudentSubscribed.type) return;
    const data = yield* StudentSubscribed.decodeStored(event);
    yield* sql.unsafe(
      `INSERT INTO course_enrolments_view (course_id, student_id, seat_number)
       SELECT $1::text, $2::text, count(*) + 1 FROM course_enrolments_view WHERE course_id = $1
       ON CONFLICT (course_id, student_id) DO NOTHING`,
      [data.courseId, data.studentId]
    );
  });

export const makeCourseEnrolmentsViewProjector = (): Effect.Effect<ViewProjector<SqlError | EventDecodingError>, never, SqlClient.SqlClient> =>
  makeTransactionalViewProjector(COURSE_ENROLMENTS_VIEW, handleEvent);

export const courseEnrolmentsViewSubscription: ViewSubscription = viewSubscriptionOf(COURSE_ENROLMENTS_VIEW, {
  eventTypes: new Set([StudentSubscribed.type])
});
```

The choice: **events that become adds, sets and removes: `defineView`; anything else: SQL.** A query builder (Kysely, Drizzle) is optional and not used here: it would only replace the SQL string.

## 3. Say which events it wants

Nothing to write: the subscription takes its event types from the handlers, so it cannot drift from what the view does. A subscription can also filter by tag (`anyOfTags`), as the wallet's views do, and carry runtime overrides.

<!-- file: examples/course-enrolment-app/src/views/CourseSeatsViewProjector.ts#subscription -->
```ts
export const courseSeatsViewSubscription: ViewSubscription = CourseSeatsView.subscription();
```

## 4. Register it with the views processor

Projectors and their subscriptions go to one processor. This is the wallet's, with four views; `service.start` is what actually begins processing. The entry point does not call it by hand: it uses `startBackgroundProcessorsScoped`, whose scope
stops the processors before the connection pool closes ([Run it in production](run-in-production.md#3-start-the-processors-serve-and-fail-loudly)).

<!-- file: examples/wallet-example-app/src/WalletApp.ts#views-processor -->
```ts
const viewsHandle = yield* makeViewsProcessor({
  config: { ...defaultViewsConfig, ...polling },
  projectors: [
    yield* makeWalletBalanceViewProjector(),
    yield* makeWalletTransactionViewProjector(),
    yield* makeWalletSummaryViewProjector(),
    yield* makeWalletStatementViewProjector()
  ],
  subscriptions: walletViewSubscriptions,
  instanceId
});
if (roles.has("views")) yield* viewsHandle.service.start;
```

## 5. Read it

Reads that must include a write go through a consistent read: [tutorial step 4](../tutorial/04-read-your-own-writes.md). Full reference for the package:
[`@crablet/views`](../../packages/views/README.md).
