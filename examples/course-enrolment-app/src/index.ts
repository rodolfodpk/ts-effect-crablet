import { createServer } from "node:http";
import { Effect, Layer, Redacted } from "effect";
import { HttpRouter } from "effect/http";
import { NodeHttpServer } from "@effect/platform-node";
import * as Crablet from "@crablet/commands/Crablet";
import { dbConnInfoFromEnv } from "./db.ts";
import { makeCourseApiLayer, startCourseViews } from "./CourseApp.ts";

// Serves the API on :8080 (PORT). The database must exist and be migrated (docker compose up -d; node src/migrate.ts).
// COURSES_DOCS=scalar|swagger also mounts a documentation page at /docs.
const conn = dbConnInfoFromEnv();
const port = Number(process.env["PORT"] ?? 8080);
const docsUi = process.env["COURSES_DOCS"];

const appLayer = Crablet.layer({
  host: conn.host,
  port: conn.port,
  database: conn.database,
  username: conn.username,
  password: Redacted.make(conn.password)
});

const server = HttpRouter.serve(
  makeCourseApiLayer(docsUi === "scalar" || docsUi === "swagger" ? { docs: { ui: docsUi } } : {})
).pipe(Layer.provide(NodeHttpServer.layer(createServer, { port })));

const program = Effect.gen(function* () {
  yield* startCourseViews();
  yield* Effect.log(`course-enrolment-app listening on :${port}`);
  yield* Layer.launch(server);
});

Effect.runPromise(Effect.provide(program, appLayer) as Effect.Effect<void, never, never>).catch((error) => {
  console.error("FATAL", error);
  process.exit(1);
});
