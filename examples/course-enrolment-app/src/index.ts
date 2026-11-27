import { createServer } from "node:http";
import { Effect, Layer } from "effect";
import { HttpRouter } from "effect/http";
import { NodeHttpServer, NodeRuntime } from "@effect/platform-node";
import * as Crablet from "@crablet/app";
import { SqlClient } from "effect/sql";
import { healthRoutes } from "@crablet/processors-http/Health";
import { readCourseConfig } from "./config.ts";
import { makeCourseApiLayer } from "./CourseApp.ts";
import { courseModules } from "./processes.ts";

// Serves the API and the probes on :8080 (PORT), and runs the views and the deadlines. The database must exist and be migrated (docker compose up -d; node src/migrate.ts).
// COURSES_DOCS=scalar|swagger also mounts a documentation page at /docs.
// COURSES_CORS_ORIGINS=http://localhost:5173 (comma-separated) lets a page served from those origins call the API from the
// browser; without it no CORS header is sent (a page behind a dev proxy, or served by this server, needs none).
// COURSES_VIEW_DELAY_MS=400 (a demo knob, default 0) makes the seats view lag that long behind a write, so a read right after
// a write is stale (?consistency=eventual) and a read that carries the write's marker has something to wait for.
const settings = await readCourseConfig(); // COURSES_* (src/config.ts): a bad value stops the start here, naming the variable
const { database } = settings;
const poolSize = database.pg.maxConnections;
const port = Number(process.env["PORT"] ?? 8080);
const docsUi = process.env["COURSES_DOCS"];
const viewDelayMs = Number(process.env["COURSES_VIEW_DELAY_MS"] ?? 0);
const corsOrigins = (process.env["COURSES_CORS_ORIGINS"] ?? "").split(",").map((o) => o.trim()).filter((o) => o !== "");

// #region crablet-layer
// COURSES_DB_POOL: at most this many connections; unset, the library's default. COURSES_DB_SESSION_HOST: a direct connection for the leader locks and LISTEN.
// The product names the connections (`course/<instance>` in pg_stat_activity), and a lock held by another product's process is logged as an error.
const appLayer = Crablet.layer(database.pg, {
  eventStore: { wakeupMode: settings.wakeupMode },
  ...(settings.product === undefined ? {} : { product: settings.product }),
  ...(database.session === undefined ? {} : { session: database.session })
});
// #endregion crablet-layer

// #region launch
// The modules COURSES_ROLES names run (unset: both), and both are listed for /status. A role that is neither `api` nor a module stops the start
// with UnknownRole. On top of the application layer, so closing it stops the modules and releases their leader locks (another instance takes over
// at once) before the connection pool closes.
const processes = Crablet.processorsFor(courseModules({ viewDelayMs }), settings.roles, { polling: settings.polling }).pipe(Layer.provideMerge(appLayer));

const program = Effect.gen(function* () {
  // Every role serves the probes (/healthz, /readyz, /status); a process without `api` serves nothing else.
  const sql = yield* SqlClient.SqlClient;
  const health = healthRoutes({ ping: sql`SELECT 1`, instance: process.env["HOSTNAME"] ?? "unknown" });
  // gracefulShutdownTimeout: a live-update connection stays open, and shutting down waits for open responses up to this long (default 20 s).
  const server = NodeHttpServer.layer(createServer, { port, gracefulShutdownTimeout: "2 seconds" });
  yield* Effect.log(`course-enrolment-app listening on :${port}; database pool: ${poolSize === undefined ? "the library's default size" : `up to ${poolSize} connections`}`);
  if (!settings.roles.app.has("api")) return yield* Layer.launch(HttpRouter.serve(health).pipe(Layer.provide(server)));
  const api = makeCourseApiLayer({
    ...(docsUi === "scalar" || docsUi === "swagger" ? { docs: { ui: docsUi } } : {}),
    ...(corsOrigins.length > 0 ? { cors: { allowedOrigins: corsOrigins as [string, ...Array<string>] } } : {})
  });
  yield* Layer.launch(HttpRouter.serve(Layer.merge(api, health)).pipe(Layer.provide(server)));
});

// `runMain` turns SIGINT and SIGTERM into an interrupt: the program's scope closes, then the processes, then the pool. A failure is logged and ends the
// process with a non-zero code.
// Set OTEL_EXPORTER_OTLP_ENDPOINT to export metrics, spans and logs over OTLP (docs/guides/operate/dashboard.md); unset, nothing is exported.
NodeRuntime.runMain(Effect.provide(Effect.scoped(program), Layer.mergeAll(processes, Crablet.observability("course-enrolment-app"))));
// #endregion launch
