import { createServer } from "node:http";
import { Effect, Layer, Redacted } from "effect";
import { HttpRouter } from "effect/http";
import { NodeHttpServer } from "@effect/platform-node";
import * as Crablet from "@crablet/commands/Crablet";
import { dbConnInfoFromEnv } from "./db.ts";
import { makeCourseApiLayer, startCourseViews } from "./CourseApp.ts";

// Serves the API on :8080 (PORT). The database must exist and be migrated (docker compose up -d; node src/migrate.ts).
// COURSES_DOCS=scalar|swagger also mounts a documentation page at /docs.
// COURSES_CORS_ORIGINS=http://localhost:5173 (comma-separated) lets a page served from those origins call the API from the
// browser; without it no CORS header is sent (a page behind a dev proxy, or served by this server, needs none).
// COURSES_VIEW_DELAY_MS=400 (a demo knob, default 0) makes the seats view lag that long behind a write, so a read right after
// a write is stale and ?waitFor=course-seats-view shows what it is for.
const conn = dbConnInfoFromEnv();
const port = Number(process.env["PORT"] ?? 8080);
const docsUi = process.env["COURSES_DOCS"];
const viewDelayMs = Number(process.env["COURSES_VIEW_DELAY_MS"] ?? 0);
const corsOrigins = (process.env["COURSES_CORS_ORIGINS"] ?? "").split(",").map((o) => o.trim()).filter((o) => o !== "");

const appLayer = Crablet.layer({
  host: conn.host,
  port: conn.port,
  database: conn.database,
  username: conn.username,
  password: Redacted.make(conn.password)
});

// gracefulShutdownTimeout: a live-update connection stays open, and shutting down waits for open responses up to this long (default 20 s).
const server = HttpRouter.serve(
  makeCourseApiLayer({
    ...(docsUi === "scalar" || docsUi === "swagger" ? { docs: { ui: docsUi } } : {}),
    ...(corsOrigins.length > 0 ? { cors: { allowedOrigins: corsOrigins as [string, ...Array<string>] } } : {})
  })
).pipe(Layer.provide(NodeHttpServer.layer(createServer, { port, gracefulShutdownTimeout: "2 seconds" })));

const program = Effect.gen(function* () {
  yield* startCourseViews(undefined, { viewDelayMs });
  yield* Effect.log(`course-enrolment-app listening on :${port}`);
  yield* Layer.launch(server);
});

Effect.runPromise(Effect.provide(program, appLayer) as Effect.Effect<void, never, never>).catch((error) => {
  console.error("FATAL", error);
  process.exit(1);
});
