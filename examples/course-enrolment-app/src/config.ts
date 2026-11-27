import { Config, Effect } from "effect";
import * as Crablet from "@crablet/app";

// #region course-database
// The connection, from COURSES_DB_* (HOST, PORT, NAME, USER, PASSWORD, or URL; POOL, unset for the library's default; SESSION_* for a direct session
// connection). The defaults match docker-compose.yml. The scripts (migrate, step 2) read this part alone.
export const courseDatabase = Crablet.databaseConfig({ name: "courses_db", username: "postgres", password: "postgres" }).pipe(Config.nested("COURSES"));
// #endregion course-database

// #region course-config
// What the server reads besides: COURSES_ROLES (`api`, the course's own, and its modules `views` and `deadlines`; unset, all), COURSES_POLL_MS,
// COURSES_BACKOFF_MAX_SECONDS, COURSES_WAKEUPS and COURSES_PRODUCT (the product that names its connections, "course" unless set). The course migrates with its script, not at start-up, so it does not read COURSES_MIGRATE.
export const courseConfig = Config.all({
  database: courseDatabase,
  roles: Crablet.rolesConfig(["api"]).pipe(Config.nested("COURSES")),
  polling: Crablet.pollingConfig.pipe(Config.nested("COURSES")),
  wakeupMode: Crablet.wakeupsConfig.pipe(Config.nested("COURSES")),
  product: Crablet.productConfig("course").pipe(Config.nested("COURSES"))
});
// #endregion course-config

export const readCourseConfig = () => Effect.runPromise(Effect.gen(function* () { return yield* courseConfig; }));

export const readCourseDatabase = () => Effect.runPromise(Effect.gen(function* () { return yield* courseDatabase; }));

// A connection with its password in the clear, as a plain pg client and the tutorial's step 2 take it.
export type DbConnInfo = ReturnType<typeof Crablet.plainConnection>;
