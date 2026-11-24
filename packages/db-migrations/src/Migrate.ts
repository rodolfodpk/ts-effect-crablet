import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { Client } from "pg";
import { migrationFiles, sqlDir } from "./index.ts";

// Where to reach the database. The same shape as `@crablet/test-support`'s `ConnInfo`.
export interface MigrateConnInfo {
  readonly host: string;
  readonly port: number;
  readonly database: string;
  readonly username: string;
  readonly password: string;
}

// An application's own migrations: the folder that holds them and the files to apply, in order. Numbered from V100, so they cannot clash with the
// framework's. Every `V*.sql` of the folder should be listed (a tool like Flyway applies the whole folder); each example checks it in a test.
export interface AppMigrations {
  readonly dir: string;
  readonly files: ReadonlyArray<string>;
}

const FIRST_APP_VERSION = 100;
const versionOf = (file: string): number | undefined => {
  const match = /^V(\d+)__.+\.sql$/u.exec(file);
  return match?.[1] === undefined ? undefined : Number(match[1]);
};

// What is wrong with an application's set, before anything is applied: a name that is not V<n>__<name>.sql, a number below V100, a file out of
// order, a file missing from the folder. Empty when nothing is.
export const problemsWith = (app: AppMigrations): ReadonlyArray<string> => {
  const problems: string[] = [];
  let previous: { readonly file: string; readonly version: number } | undefined;
  for (const file of app.files) {
    const version = versionOf(file);
    if (version === undefined) problems.push(`"${file}" is not named V<n>__<name>.sql`);
    else if (version < FIRST_APP_VERSION) problems.push(`"${file}" is numbered below V${FIRST_APP_VERSION}, where the framework's migrations are`);
    else {
      if (previous !== undefined && version <= previous.version) problems.push(`"${file}" comes after "${previous.file}"`);
      previous = { file, version };
    }
    if (!existsSync(path.join(app.dir, file))) problems.push(`"${file}" is not in ${app.dir}`);
  }
  return problems;
};

const checked = (app: AppMigrations | undefined): ReadonlyArray<string> => {
  if (app === undefined) return [];
  const problems = problemsWith(app);
  if (problems.length > 0) throw new Error(`the application's migrations cannot be applied: ${problems.join("; ")}`);
  return app.files.map((file) => path.join(app.dir, file));
};

// Plain `pg.Client` and async, not Effect: this runs before any layer exists, at deploy time or before a start (the same reasoning as
// `startTestDb`). The client is closed whatever happens.
const withClient = async <A>(conn: MigrateConnInfo, use: (client: Client) => Promise<A>): Promise<A> => {
  const client = new Client({ host: conn.host, port: conn.port, database: conn.database, user: conn.username, password: conn.password });
  await client.connect();
  try {
    return await use(client);
  } finally {
    await client.end();
  }
};

// Applies the given files in one transaction: a file that fails leaves the database as it was (none of these files holds a statement Postgres
// refuses in a transaction, such as CREATE INDEX CONCURRENTLY).
const applyAll = async (client: Client, files: ReadonlyArray<string>): Promise<void> => {
  await client.query("BEGIN");
  try {
    for (const file of files) await client.query(readFileSync(file, "utf-8"));
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
};

const coreFiles = (): ReadonlyArray<string> => migrationFiles.map((file) => path.join(sqlDir, file));

// The framework's schema, then the application's own, in one transaction. Run it once, against a FRESH database: the files are not idempotent and
// nothing records what was applied (docs/guides/operate/run-in-production.md). The application's set is checked first (`problemsWith`), before
// connecting.
export async function migrate(conn: MigrateConnInfo, app?: AppMigrations): Promise<void> {
  const files = [...coreFiles(), ...checked(app)];
  await withClient(conn, (client) => applyAll(client, files));
}

// The application's set alone, checked and in one transaction, on a database that already has the framework's schema: what a test does after
// `startTestDb()`, which applies the framework's.
export async function migrateApp(conn: MigrateConnInfo, app: AppMigrations): Promise<void> {
  const files = checked(app);
  await withClient(conn, (client) => applyAll(client, files));
}

// `migrate`, only on a database without the event log; one that has it is left as it is, which is what lets an application restart against it.
// It does not detect a half-applied or an older schema (a half-applied one cannot happen here: `migrate` is one transaction). Several processes
// started together against an empty database can all find it empty, and all but one then fail: in a deployment of several instances, apply the
// schema with a pre-deploy job instead (ADR-0022, decision 6).
export async function migrateIfFresh(conn: MigrateConnInfo, app?: AppMigrations): Promise<"applied" | "present"> {
  const files = [...coreFiles(), ...checked(app)];
  return withClient(conn, async (client) => {
    const present = (await client.query<{ present: boolean }>("SELECT to_regclass('public.crablet_events') IS NOT NULL AS present")).rows[0]?.present === true;
    if (present) return "present";
    await applyAll(client, files);
    return "applied";
  });
}
