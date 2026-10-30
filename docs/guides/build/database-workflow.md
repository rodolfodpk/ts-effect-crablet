# The database workflow

*Guide · developers changing the schema · [Add a view](add-a-view.md) · 10 minutes*

From a schema change to a view that still works: write the migration, change what the code declares about the table, and let the tests find any disagreement. Crablet takes any `sql`, so none of this is required by the libraries; this is how the examples do it.

[← Task guides](../README.md)

## The loop

Every change to a view table goes through the same steps, from `examples/course-enrolment-app`:

1. **Write the migration.** A new file in `db/migration`, numbered from `V100` so it cannot clash with the framework's (`V1` to `V7`), for example `V103__course_waitlist.sql`. Add it to `appMigrationFiles` in
   [`migrate.ts`](../../../examples/course-enrolment-app/src/migrate.ts).
2. **Apply it to your development database.** `node src/migrate.ts`. The files are not idempotent and there is no record of what was applied, so it runs against a **fresh** database (`docker compose down -v`, then `up -d`, then migrate).
   For an existing database you apply only the files it has not had, with your own tooling ([run it in production](../operate/run-in-production.md#1-apply-the-migrations)).
3. **Change what the code says about the table.** A declared view has a `viewTable` (its columns, types, nullability, defaults and key); a read has a row schema (`SeatsRow` in
   [`CourseQueryApiLive.ts`](../../../examples/course-enrolment-app/src/api/CourseQueryApiLive.ts)); a view written with `raw` has its own SQL.
4. **Run the tests** (Docker). They report what still disagrees with the migrated database.

The read in step 3, as the course app writes it:

<!-- file: examples/course-enrolment-app/src/api/CourseQueryApiLive.ts#row-schema -->
```ts
// A row of course_seats_view as the database sends it, checked on every read: a column that was renamed or changed type fails here, naming the field.
const SeatsRow = Schema.Struct({ course_id: Schema.String, capacity: Schema.Int, subscribers: Schema.Int });

// One page of courses by keyset on course_id. `after` and `q` are optional filters (null: none); the caller asks for one row more than the page, to know whether there is a next page.
// (LIKE escapes with a backslash unless told otherwise, which is what likePrefix assumes.)
const listSeats = (sql: SqlClient.SqlClient) =>
  SqlSchema.findAll({
    Request: Schema.Struct({ after: Schema.NullOr(Schema.String), q: Schema.NullOr(Schema.String), limit: Schema.Number }),
    Result: SeatsRow,
    execute: ({ after, q, limit }) => {
      const where: Array<string> = [];
      const params: Array<string | number> = [];
      if (after !== null) where.push(`course_id > $${params.push(after)}`);
      if (q !== null && q !== "") where.push(`course_id LIKE $${params.push(likePrefix(q))}`);
      return sql.unsafe(
        `SELECT course_id, capacity, subscribers FROM course_seats_view${where.length > 0 ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY course_id LIMIT $${params.push(limit)}`,
        params
      );
    }
  });

const findSeats = (sql: SqlClient.SqlClient) =>
  SqlSchema.findOneOption({
    Request: Schema.Struct({ courseId: Schema.String }),
    Result: SeatsRow,
    execute: ({ courseId }) => sql.unsafe("SELECT course_id, capacity, subscribers FROM course_seats_view WHERE course_id = $1", [courseId])
  });
```

## What keeps it honest

| Check | Where | What it catches |
|---|---|---|
| The declared-table test | [`course-seats-table.test.ts`](../../../examples/course-enrolment-app/test/integration/course-seats-table.test.ts) (`checkViewTables`) | a migration renamed, retyped or dropped a column a `viewTable` declares, changed its nullability or default or the key, or added a NOT NULL column without a default that the declaration does not know |
| The row schema of a read | `SqlSchema` (`Result: SeatsRow`), at every read | a column that was renamed or changed type: it fails naming the field, instead of later in a conversion (a `numeric` arrives as text and a `timestamptz` as a date: the schema converts them) |
| The integration tests | `test/integration/` | the SQL of a view written with `raw` and of every read, against a real Postgres, in the transaction of the view's cursor |
| The type check | `bun run typecheck` | an operation on a declared table that names a column it does not have, or gives it a value of another type |
| CI | `.github/workflows/ci.yml` | all of the above, so a disagreement cannot be merged |

## Things worth knowing

- **The table is described twice**: in the migration (the truth) and in `viewTable`. `checkViewTables` is what keeps them equal; a rename is two edits and one failing test if you forget one.
- **Only the SQL of a declared view is generated.** A view's `raw` SQL and a read are SQL strings that nothing checks until a test runs them; write the test ([`course-enrolments-view.test.ts`](../../../examples/course-enrolment-app/test/integration/course-enrolments-view.test.ts) is the example).
- **Production does not run any of this.** The schema reaches a real database through your deployment's migration step (a pre-deploy job, not every instance at start-up: [run it in production](../operate/run-in-production.md)), and nothing here connects to it.
- **A query builder is optional.** An app that wants typed SQL (Kysely, Drizzle) can add one: the libraries do not depend on it, and a projector or a read only needs to run its SQL on the `sql` it is given.
