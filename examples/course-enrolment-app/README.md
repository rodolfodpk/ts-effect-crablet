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

`docker compose down -v` removes the database. The tutorial explains each step and what to try with `curl`.

## Where things are

| Path | What |
|---|---|
| `src/domain/` | events, models, the two contracts (`enrolment.contract.ts`) and the commands |
| `src/CourseApi.ts`, `src/CourseApp.ts` | the API declared from contracts, and the server that implements it |
| `src/views/`, `src/api/` | the seat-map view and the read endpoints |
| `scripts/` | `generate-openapi.ts` (writes [`docs/api/course-enrolment-openapi.json`](../../docs/api/course-enrolment-openapi.json)), `step2-postgres.ts`, `bench-reads.ts` (what a consistent read costs; needs Docker) |
| `tutorial/` | the step 1 test the tutorial shows |
| `test/` | unit tests, including the one that keeps the tutorial's code equal to these files; `test/integration/` needs Docker |

The page for this API is [`course-enrolment-ui`](../course-enrolment-ui/README.md).
