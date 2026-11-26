import { createServer } from "node:http";
import { Effect, Layer, Redacted } from "effect";
import { HttpRouter } from "effect/http";
import { SqlClient } from "effect/sql";
import { NodeHttpServer, NodeRuntime } from "@effect/platform-node";
import * as Crablet from "@crablet/app";
import { healthRoutes } from "@crablet/processors-http/Health";
import { migrateIfFresh } from "@crablet/db-migrations/Migrate";
import { walletMigrations } from "./migrate.ts";
import { makeWalletAdminApiLayer, makeWalletApiLayer } from "./WalletApp.ts";
import { walletProcesses } from "./processes.ts";
import { readWalletConfig } from "./config.ts";

const port = Number(process.env["PORT"] ?? 8080);

// Entry point: apply migrations (to a fresh database only), then start the app - views/
// automations/outbox background processors AND the HTTP server, all sharing one connection pool.
async function main(): Promise<void> {
  // WALLET_* (src/config.ts): a bad value stops the start here, naming the variable.
  const settings = await readWalletConfig();
  const { polling } = settings; // WALLET_POLL_MS, WALLET_BACKOFF_MAX_SECONDS; with WALLET_WAKEUPS=off the processors do not LISTEN (they follow the event store)
  const poolSize = settings.pg.maxConnections;
  // WALLET_MIGRATE=off: the schema is applied by a pre-deploy job (`node src/migrate.ts`), as it must be when several instances start together (ADR-0022, decision 6).
  if (!settings.migrate) console.log("migrations: not applied by this process (WALLET_MIGRATE=off)");
  else console.log(`migrations: ${(await migrateIfFresh(Crablet.plainConnection(settings.pg), walletMigrations)) === "applied" ? "applied to a fresh database" : "the schema is already there, left as it is"}`);

  // WALLET_DB_SESSION_HOST (and _PORT, _NAME, _USER, _PASSWORD, _POOL): a DIRECT connection for the leader locks and LISTEN while WALLET_DB_HOST points at a
  // pooler in transaction mode (PgBouncer); its pool must cover what the roles keep for good (2 per worker role, 1 for the api). See docs/guides/operate/run-in-production.md.
  const appLayer = Crablet.layer(settings.pg, settings.options);

  const runsApi = settings.roles.app.has("api");
  const program = Effect.gen(function* () {
    yield* Effect.log(`wallet-example-app roles: ${settings.roles.modules === "all" ? "all" : [...settings.roles.app, ...settings.roles.modules].join(",")}; listening on :${port}; wake-ups: ${settings.options.eventStore.wakeupMode}; polling: ${polling.pollingIntervalMs} ms, idle up to ${polling.backoffMaxSeconds} s; database pool: ${poolSize === undefined ? "the library's default size" : `up to ${poolSize} connections`}; leader and LISTEN: ${settings.options.session === undefined ? "on the main connection" : `direct to ${settings.options.session.host}:${settings.options.session.port}`}`);
    // Every role serves the probes (/healthz, /readyz, /status: what this process runs and leads, from `Processors`); a process without `api` serves nothing else.
    const sql = yield* SqlClient.SqlClient;
    const health = healthRoutes({ ping: sql`SELECT 1`, instance: process.env["HOSTNAME"] ?? "unknown" });
    const server = NodeHttpServer.layer(createServer, { port });
    if (!runsApi) return yield* Layer.launch(HttpRouter.serve(health).pipe(Layer.provide(server)));
    // The admin API (list, pause, resume and reset the processors) exists only when WALLET_ADMIN_TOKEN is set, and is behind that bearer token.
    const adminToken = process.env["WALLET_ADMIN_TOKEN"];
    const admin = adminToken === undefined || adminToken === "" ? Layer.empty : makeWalletAdminApiLayer(Redacted.make(adminToken));
    if (admin !== Layer.empty) yield* Effect.log("admin API mounted at /admin/processors and /admin/events (bearer token from WALLET_ADMIN_TOKEN)");
    yield* Layer.launch(HttpRouter.serve(Layer.mergeAll(makeWalletApiLayer({ basePath: "/api/commands" }), admin, health)).pipe(Layer.provide(server)));
  });

  // The modules WALLET_ROLES names run, and all three are listed (a process with only `api` runs no loop and holds no leader lock); a role that is
  // neither `api` nor a module stops the start with UnknownRole. The processes layer sits on the application layer, so closing it stops the modules
  // and releases their leader locks (another instance takes over at once) before the connection pool closes. It samples the consumer and storage
  // gauges for the modules it runs. Set OTEL_EXPORTER_OTLP_ENDPOINT to export metrics, spans and logs over OTLP (docs/guides/operate/dashboard.md).
  // `runMain` turns SIGINT and SIGTERM into an interrupt; a failure is logged and ends the process with a non-zero code.
  const processes = walletProcesses(settings.roles, { polling }).pipe(Layer.provideMerge(appLayer));
  NodeRuntime.runMain(Effect.provide(Effect.scoped(program), Layer.mergeAll(processes, Crablet.observability("wallet-example-app"))));
}

main().catch((error) => {
  console.error("FATAL", error);
  process.exit(1);
});
