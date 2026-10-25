# course-enrolment-app

The service the [tutorial](../../docs/tutorial/README.md) builds: **a course holds at most N students** and **a student takes at most 3 courses**, two rules about different
things decided together in one atomic command. It adds Postgres, an HTTP API with a generated OpenAPI description, one view, and reads that wait for a write's marker.

## Run it

```bash
cd examples/course-enrolment-app
docker compose up -d        # Postgres 18 on localhost:5432 (set COURSES_DB_PORT to change the port)
node src/migrate.ts         # once per fresh database
node src/index.ts           # the API on :8080 (set PORT to change it; COURSES_DOCS=scalar also serves /docs)
```

`docker compose down -v` removes the database. `COURSES_DB_POOL` sets the most connections the pool may open (unset: the library's default of 10; [how to size it](../../docs/guides/operate/run-in-production.md#size-the-pool)). The tutorial explains each step and what to try with `curl`.

## Where things are

| Path | What |
|---|---|
| `src/domain/` | events, models, the two contracts (`enrolment.contract.ts`) and the commands: `Enrolment.ts` (the tutorial's two rules), `CourseStart.ts` (a course is confirmed once it has a teacher, a room and enough students, and cancelled if it has not 14 days after it was defined: [aggregate events](../../docs/guides/build/aggregate-events.md)), `Payments.ts` (prices, payment within a three-day window, releasing an unpaid subscription when the window closes, by a deadline `Subscribe` sets: [set a deadline](../../docs/guides/build/set-a-deadline.md), receipts) |
| `src/automations/` | `ConfirmCourseAutomation` (several events wake one command) and `ReceiptOnPaymentAutomation` (one event, one command); declared and tested, not started by `src/index.ts` |
| `src/CourseApi.ts`, `src/CourseApp.ts` | the API declared from contracts, the server that implements it, and the processors `src/index.ts` starts: the views and the deadlines |
| `src/views/`, `src/api/` | the seat-map view, declared with `defineView` (what each event does to its table, compared with the migrated database by a test), and the read endpoints, which read through `SqlSchema` (the row type is checked against the database on every read; [the database workflow](../../docs/guides/build/database-workflow.md)). `CourseEnrolmentsViewProjector` is a `defineView` that writes with its own SQL (`raw`), for what the table operations cannot say, read by `GET /api/courses/:courseId/enrolments` |
| `scripts/` | `generate-openapi.ts` (writes [`docs/api/course-enrolment-openapi.json`](../../docs/api/course-enrolment-openapi.json)), `step2-postgres.ts`, `bench-reads.ts` (what a consistent read costs; needs Docker) |
| `tutorial/` | the step 1 test the tutorial shows |
| `test/` | unit tests, including the one that keeps the tutorial's code equal to these files; `test/integration/` needs Docker |

Its architecture as C4 diagrams (context, containers, components): [C4 models](../../docs/concepts/c4-examples.md#course-enrolment).

The page for this API is [`course-enrolment-ui`](../course-enrolment-ui/README.md).
