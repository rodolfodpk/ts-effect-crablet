// Connection settings: the defaults match docker-compose.yml, override with COURSES_DB_* environment variables.
export interface DbConnInfo {
  readonly host: string;
  readonly port: number;
  readonly database: string;
  readonly username: string;
  readonly password: string;
}

export const dbConnInfoFromEnv = (): DbConnInfo => ({
  host: process.env["COURSES_DB_HOST"] ?? "localhost",
  port: Number(process.env["COURSES_DB_PORT"] ?? 5432),
  database: process.env["COURSES_DB_NAME"] ?? "courses_db",
  username: process.env["COURSES_DB_USER"] ?? "postgres",
  password: process.env["COURSES_DB_PASSWORD"] ?? "postgres"
});

// The most connections the pool may open (COURSES_DB_POOL). Unset: the library's own default, so a deployment that never sets it behaves as before. The pool is shared
// by commands, reads, the view processor, and the connections this process holds for good (see "Size the pool" in docs/guides/run-in-production.md).
export const poolSizeFromEnv = (value: string | undefined = process.env["COURSES_DB_POOL"]): number | undefined => {
  if (value === undefined || value.trim() === "") return undefined;
  const size = Number(value);
  if (!Number.isInteger(size) || size < 1) throw new Error(`COURSES_DB_POOL must be a whole number of 1 or more, got "${value}"`);
  return size;
};
