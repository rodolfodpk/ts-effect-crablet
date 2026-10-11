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

A migration of your own, numbered from `V100` so it cannot clash with the framework's: [`V100__course_seats_view.sql`](../../examples/course-enrolment-app/db/migration/V100__course_seats_view.sql).
Keep a column for the position of the last event applied if the projector must be idempotent by itself (a write outside the given `sql`, or a view also fed by other code). List the file in `appMigrationFiles` in
[`migrate.ts`](../../examples/course-enrolment-app/src/migrate.ts). Then generate the types the queries are checked against: `npm run db:types`, and commit the generated file with the migration
([the database workflow](database-workflow.md)).

## 2. Write the projector

One function from an event to SQL. The transactional projector runs a whole batch in one transaction, so a failure rolls the batch back. Read the payload with `decodeStored`, never by casting `event.data`: an event the
current definition cannot read then fails the batch with a typed `EventDecodingError` instead of projecting something wrong.

The example builds its SQL with [Kysely](https://kysely.dev), against the types generated from your migrated schema (`queryBuilder.ts`: a `Kysely` whose driver never connects, and a `run(sql, query)` that executes what it built on the `sql` the projector is given).
A misspelled column, a value of the wrong type, or a column a migration renamed is then a compile error, not a failure at the first event. Because `run` uses the given `sql`, the writes stay in the transaction of the view's cursor. Crablet itself does not depend on Kysely:
the libraries take any `sql`, and plain SQL (`sql.unsafe`, as the wallet's projectors do) works the same way, with the mistakes found at runtime instead.

<!-- file: examples/course-enrolment-app/src/views/CourseSeatsViewProjector.ts#projector -->
```ts
// Seats per course. Each event is applied once even if it is delivered again: the row remembers the position of the
// last event it applied, and an event at or before that position is ignored. That is sound here because the events that
// touch one course are written one after another (their commands share a boundary), so a course's positions only grow;
// for events of unrelated transactions, delivery order is not position order, so key idempotency on the event instead.
//
// The SQL is built with Kysely against the types generated from the migrated schema (db.generated.ts): a misspelled column, a value of the wrong type or a column a migration renamed is a compile error, not a failure at the first event.
//
// `decodeStored` reads the payload through the event's own definition: one this definition cannot read fails the batch with a typed `EventDecodingError`
// (position, type, issues), which the processor records against the view, instead of projecting something wrong. Casting `event.data` would validate nothing.
const handleEvent = (event: StoredEvent, sql: SqlClient.SqlClient): Effect.Effect<void, SqlError | EventDecodingError, never> =>
  Effect.gen(function* () {
    switch (event.type) {
      case CourseDefined.type: {
        const data = yield* CourseDefined.decodeStored(event);
        yield* run(sql,
          qb.insertInto("course_seats_view")
            .values({ course_id: data.courseId, capacity: data.capacity, subscribers: 0, last_position: event.position })
            .onConflict((oc) => oc.column("course_id").doNothing())
        );
        return;
      }
      case StudentSubscribed.type: {
        const data = yield* StudentSubscribed.decodeStored(event);
        yield* run(sql,
          qb.updateTable("course_seats_view")
            .set((eb) => ({ subscribers: eb("subscribers", "+", 1), last_position: event.position }))
            .where("course_id", "=", data.courseId)
            .where("last_position", "<", event.position)
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

## 3. Say which events it wants

<!-- file: examples/course-enrolment-app/src/views/CourseSeatsViewProjector.ts#subscription -->
```ts
export const courseSeatsViewSubscription: ViewSubscription = viewSubscriptionOf(COURSE_SEATS_VIEW, {
  eventTypes: new Set([CourseDefined.type, StudentSubscribed.type])
});
```

A subscription can also filter by tag (`anyOfTags`), as the wallet's views do.

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
