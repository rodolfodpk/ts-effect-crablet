# Add a view

A view is a table kept up to date from events by a **projector**. It updates asynchronously, and a projector must be **idempotent**, because delivery is
at-least-once ([reference](../reference.md#views-the-outbox-and-automations)). The example is the course app's seat counter.

[← Task guides](README.md)

## 1. Create the table

A migration of your own, numbered from `V100` so it cannot clash with the framework's: [`V100__course_seats_view.sql`](../../examples/course-enrolment-app/db/migration/V100__course_seats_view.sql).
Keep a column for the position of the last event applied; that is what makes the projector idempotent. List the file in `appMigrationFiles` in
[`migrate.ts`](../../examples/course-enrolment-app/src/migrate.ts).

## 2. Write the projector

One function from an event to SQL. The transactional projector runs a whole batch in one transaction, so a failure rolls the batch back. Read the payload with `decodeStored`, never by casting `event.data`: an event the
current definition cannot read then fails the batch with a typed `EventDecodingError` instead of projecting something wrong.

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
  config: defaultViewsConfig,
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
