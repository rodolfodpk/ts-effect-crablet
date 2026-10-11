# The database workflow

From a schema change to a query the compiler checks: write the migration, generate the types from it, write the queries against them, and let the tests keep the two in step. The example is the course app, which builds its view's SQL with
[Kysely](https://kysely.dev) ([add a view](add-a-view.md)). Crablet itself does not depend on Kysely or on any of this: the libraries take any `sql`, and an app that writes plain SQL (the wallet does) simply skips the generation step.

[← Task guides](README.md)

## The loop

Every change to a view table goes through the same steps, from `examples/course-enrolment-app`:

1. **Write the migration.** A new file in `db/migration`, numbered from `V100` so it cannot clash with the framework's (`V1` to `V13`), for example `V101__course_waitlist.sql`. Add it to `appMigrationFiles` in
   [`migrate.ts`](../../examples/course-enrolment-app/src/migrate.ts).
2. **Apply it to your development database.** `node src/migrate.ts`. The files are not idempotent and there is no record of what was applied, so it runs against a **fresh** database (`docker compose down -v`, then `up -d`, then migrate).
   For an existing database you apply only the files it has not had, with your own tooling ([run it in production](run-in-production.md#1-apply-the-migrations)).
3. **Generate the types.** `npm run db:types`. It starts a throwaway Postgres (Testcontainers, so Docker must be running), applies the framework's migrations and the app's to it, and writes
   [`src/views/db.generated.ts`](../../examples/course-enrolment-app/src/views/db.generated.ts) with [`kysely-codegen`](https://github.com/RobinBlomberg/kysely-codegen), for the `course_*` tables only.
   It does **not** read your development or production database, so the result depends only on the migration files.
4. **Commit the migration and the generated file together.** A reviewer then sees the schema change and what it did to the types in one diff.
5. **Fix what the compiler reports.** `npm run typecheck` (from the repository root) lists every query written against the old shape: a renamed column, a column that is now nullable, a type that changed. Nothing is left to fail at the first event.
6. **Write or change the queries** with the editor completing table and column names, then run the tests.

What step 3 runs is the generator's options, in [`scripts/db-types.ts`](../../examples/course-enrolment-app/scripts/db-types.ts):

<!-- file: examples/course-enrolment-app/scripts/db-types.ts#codegen-options -->
```ts
const options = [
  "--dialect", "postgres",
  "--include-pattern", "course_*",
  "--log-level", "error"
];
```

## What keeps it honest

| Check | Where | What it catches |
|---|---|---|
| The type check | `npm run typecheck` | a query that no longer fits the generated types |
| The drift test | [`course-db-types.test.ts`](../../examples/course-enrolment-app/test/integration/course-db-types.test.ts), or `npm run db:types:check` | a migration changed a table and `db:types` was not run (the committed file is not what the schema generates) |
| The integration tests | `test/integration/` (Docker) | the real queries against a real Postgres, in the transaction of the view's cursor |
| CI | `.github/workflows/ci.yml` | all of the above, so a stale file cannot be merged |

The drift test generates the file again from the migrations and compares it with the committed one; it fails with the codegen's own message, and the fix is always `npm run db:types`.

## Things worth knowing

- **The types describe the database, not the driver.** The generated type of a `BIGINT` reads as text, and `@effect/sql-pg` hands back a `bigint`. [`queryBuilder.ts`](../../examples/course-enrolment-app/src/views/queryBuilder.ts) corrects that with a small mapped type, so
  the generated file stays exactly what the tool produced (which is what lets `--verify` compare it). Driver differences of that kind go there, not into the generated file.
- **Do not edit `db.generated.ts` by hand, and do not merge it by hand.** After a merge conflict, resolve the migrations and run `npm run db:types` again.
- **Regenerate after every migration that touches a view table**, even one that only adds a column with a default: the generated type says whether the column is required on insert.
- **Only the app's view tables are generated** (`--include-pattern "course_*"`). The framework's tables (`crablet_events` and the others) are not Kysely's business: the library queries them itself.
- **Production does not run any of this.** The generated file is source code. The schema reaches a real database through your deployment's migration step (a pre-deploy job, not every instance at start-up: [run it in production](run-in-production.md)), and nothing in the loop connects to it.
- **A fragment Kysely does not model** (a row-value comparison, an `xid8` cast) goes through its `sql` template and is not checked, which is the price of an escape hatch; the integration tests are what cover it.
