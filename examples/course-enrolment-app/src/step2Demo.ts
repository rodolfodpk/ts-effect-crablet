// TUTORIAL STEP 2 - the SAME commands, run for real against Postgres.
//   docker compose up -d && node src/migrate.ts && node scripts/step2-postgres.ts
// `runStep2` returns what happened so the integration test can assert it; the script just prints it.
import { Effect, Redacted } from "effect";
import * as Crablet from "@crablet/commands/Crablet";
import { CommandExecutor } from "@crablet/commands";
import { CourseFull, DefineCourse, StudentAtLimit, Subscribe } from "./domain/Enrolment.ts";
import type { DbConnInfo } from "./db.ts";

export interface Step2Summary {
  readonly lastSeat: ReadonlyArray<"subscribed" | "CourseFull">;
  readonly studentLimit: ReadonlyArray<"subscribed" | "StudentAtLimit">;
}

const outcomeOf = <A extends string, R>(program: Effect.Effect<unknown, unknown, R>, refusals: ReadonlyArray<readonly [new (...a: any[]) => object, A]>) =>
  program.pipe(
    Effect.map(() => "subscribed" as const),
    Effect.catch((error) => {
      const refusal = refusals.find(([cls]) => error instanceof cls);
      return refusal !== undefined ? Effect.succeed(refusal[1]) : Effect.fail(error);
    })
  );

export const runStep2 = (conn: DbConnInfo, log: (line: string) => void = () => {}): Promise<Step2Summary> => {
  const AppLive = Crablet.layer({
    host: conn.host,
    port: conn.port,
    database: conn.database,
    username: conn.username,
    password: Redacted.make(conn.password)
  });
  const run = <A, E>(effect: Effect.Effect<A, E, any>) => Effect.runPromise(Effect.provide(effect, AppLive) as Effect.Effect<A, E, never>);
  const id = crypto.randomUUID().slice(0, 8); // so the script can be run again against the same database

  const program = Effect.gen(function* () {
    const executor = yield* CommandExecutor;
    const subscribe = (studentId: string, courseId: string) =>
      outcomeOf(executor.run(Subscribe, { studentId, courseId }), [[CourseFull, "CourseFull"]]);

    // Rule 1: a course holds at most `capacity` students. Two students race for the LAST seat.
    yield* executor.run(DefineCourse, { courseId: `physics-${id}`, capacity: 1 });
    const lastSeat = yield* Effect.all([subscribe(`ann-${id}`, `physics-${id}`), subscribe(`bob-${id}`, `physics-${id}`)], { concurrency: 2 });
    log(`two students race for the last seat: ${lastSeat.join(", ")}`);

    // Rule 2: a student takes at most 3 courses. The fourth is refused.
    const studentLimit: Array<"subscribed" | "StudentAtLimit"> = [];
    for (const n of [1, 2, 3, 4]) {
      yield* executor.run(DefineCourse, { courseId: `c${n}-${id}`, capacity: 10 });
      studentLimit.push(
        yield* outcomeOf(executor.run(Subscribe, { studentId: `cy-${id}`, courseId: `c${n}-${id}` }), [[StudentAtLimit, "StudentAtLimit"]])
      );
    }
    log(`one student subscribes to four courses: ${studentLimit.join(", ")}`);
    return { lastSeat, studentLimit } satisfies Step2Summary;
  });
  return run(program);
};
