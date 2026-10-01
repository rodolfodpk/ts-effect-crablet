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
