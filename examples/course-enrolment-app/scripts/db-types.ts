// The types of this app's view tables for Kysely (src/views/db.generated.ts), generated from the real schema: the framework's migrations and this app's, applied to a throwaway Postgres (Testcontainers, needs Docker).
// A migration that changes a view table changes this file, and every query written against the old shape stops compiling.
//
//   npm run db:types         write src/views/db.generated.ts
//   npm run db:types:check   fail if the committed file is not what the schema generates (what test/integration/course-db-types.test.ts runs)
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startTestDb } from "@crablet/test-support";
import { applyAppMigrations } from "../test/support/applyAppMigrations.ts";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
export const generatedFile = path.join(root, "src", "views", "db.generated.ts");
const codegen = createRequire(import.meta.url).resolve("kysely-codegen/dist/cli/bin.js");

// Only this app's view tables (not the event store's). No type overrides: kysely-codegen's override options need the TypeScript compiler API, which TypeScript 7 does not expose, and what the driver hands back that the database
// cannot tell (a BIGINT is a bigint with @effect/sql-pg) is corrected in src/views/queryBuilder.ts, so this file stays exactly what the tool writes.
// #region codegen-options
const options = [
  "--dialect", "postgres",
  "--include-pattern", "course_*",
  "--log-level", "error"
];
// #endregion codegen-options

// `outFile` is where the types are written, or the file that is checked: the committed one unless a test says otherwise.
export const generateDbTypes = async (mode: "write" | "verify", outFile: string = generatedFile): Promise<void> => {
  const db = await startTestDb();
  try {
    await applyAppMigrations(db.connInfo);
    const { host, port, database, username, password } = db.connInfo;
    const url = `postgres://${encodeURIComponent(username)}:${encodeURIComponent(password)}@${host}:${port}/${database}`;
    execFileSync(process.execPath, [codegen, ...options, "--out-file", outFile, "--url", url, ...(mode === "verify" ? ["--verify"] : [])], { stdio: "inherit", cwd: root });
  } finally {
    await db.stop();
  }
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  generateDbTypes(process.argv.includes("--verify") ? "verify" : "write").then(
    () => console.log(process.argv.includes("--verify") ? "db.generated.ts is up to date" : `wrote ${path.relative(root, generatedFile)}`),
    (error) => { console.error(error instanceof Error ? error.message : error); process.exit(1); }
  );
}
