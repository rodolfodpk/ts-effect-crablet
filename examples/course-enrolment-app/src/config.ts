import { Config, Effect } from "effect";
import * as Crablet from "@crablet/app";

// #region course-database
// The connection, from COURSES_DB_* (HOST, PORT, NAME, USER, PASSWORD, or URL; POOL, unset for the library's default; SESSION_* for a direct session
// connection). The defaults match docker-compose.yml. The course runs no roles and migrates with a script, so it reads this part alone.
export const courseDatabase = Crablet.databaseConfig({ name: "courses_db", username: "postgres", password: "postgres" }).pipe(Config.nested("COURSES"));
// #endregion course-database

export const readCourseDatabase = () => Effect.runPromise(Effect.gen(function* () { return yield* courseDatabase; }));

// A connection with its password in the clear, as a plain pg client and the tutorial's step 2 take it.
export type DbConnInfo = ReturnType<typeof Crablet.plainConnection>;
