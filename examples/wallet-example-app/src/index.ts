import { createServer } from "node:http";
import { Effect, Layer, Redacted } from "effect";
import { HttpRouter } from "effect/http";
import { SqlClient } from "effect/sql";
import { NodeHttpServer, NodeRuntime } from "@effect/platform-node";
import * as Crablet from "@crablet/app";
import { Processors } from "@crablet/modules/Processors";
import { healthRoutes } from "@crablet/processors-http/Health";
import { monitorStorage } from "@crablet/eventstore/Storage";
import { migrateIfFresh } from "@crablet/db-migrations/Migrate";
import { walletMigrations } from "./migrate.ts";
import { startBackgroundProcessors, monitorBackgroundProcessors, walletProcessors, makeWalletAdminApiLayer, makeWalletApiLayer } from "./WalletApp.ts";
import { observabilityLayer } from "./Observability.ts";
import { hasWorkers, rolesOf } from "./roles.ts";
import { readWalletConfig } from "./config.ts";

const port = Number(process.env["PORT"] ?? 8080);

// Entry point: apply migrations (to a fresh database only), then start the app - views/
// automations/outbox background processors AND the HTTP server, all sharing one connection pool.
async function main(): Promise<void> {
  // WALLET_* (src/config.ts): a bad value stops the start here, naming the variable.
  const settings = await readWalletConfig();
  const roles = rolesOf(settings.roles); // WALLET_ROLES; unset = all, the single process (ADR-0022)
  const { polling } = settings; // WALLET_POLL_MS, WALLET_BACKOFF_MAX_SECONDS; with WALLET_WAKEUPS=off the processors do not LISTEN (they follow the event store)
  const poolSize = settings.pg.maxConnections;
  // WALLET_MIGRATE=off: the schema is applied by a pre-deploy job (`node src/migrate.ts`), as it must be when several instances start together (ADR-0022, decision 6).
  if (!settings.migrate) console.log("migrations: not applied by this process (WALLET_MIGRATE=off)");
  else console.log(`migrations: ${(await migrateIfFresh(Crablet.plainConnection(settings.pg), walletMigrations)) === "applied" ? "applied to a fresh database" : "the schema is already there, left as it is"}`);

  // WALLET_DB_SESSION_HOST (and _PORT, _NAME, _USER, _PASSWORD, _POOL): a DIRECT connection for the leader locks and LISTEN while WALLET_DB_HOST points at a
  // pooler in transaction mode (PgBouncer); its pool must cover what the roles keep for good (2 per worker role, 1 for the api). See docs/guides/operate/run-in-production.md.
  const appLayer = Crablet.layer(settings.pg, settings.options);

  const program = Effect.gen(function* () {
    // Every handle is built; only the modules named in WALLET_ROLES are started. A process with only `api` runs no loop and holds no leader lock.
    const processors = yield* startBackgroundProcessors({ roles, polling });
    yield* monitorBackgroundProcessors(processors);
    if (hasWorkers(roles)) yield* Effect.forkScoped(monitorStorage({ every: "1 minute" })); // the crablet.storage.* gauges
    yield* Effect.log(`wallet-example-app roles: ${[...roles].join(",")}; listening on :${port}; wake-ups: ${settings.options.eventStore.wakeupMode}; polling: ${polling.pollingIntervalMs} ms, idle up to ${polling.backoffMaxSeconds} s; database pool: ${poolSize === undefined ? "the library's default size" : `up to ${poolSize} connections`}; leader and LISTEN: ${settings.options.session === undefined ? "on the main connection" : `direct to ${settings.options.session.host}:${settings.options.session.port}`}`);
    // Every role serves the probes (/healthz, /readyz, /status: what this process runs and leads); a process without `api` serves nothing else.
    const modules = yield* walletProcessors(processors);
    const sql = yield* SqlClient.SqlClient;
    const health = healthRoutes({ ping: sql`SELECT 1`, instance: process.env["HOSTNAME"] ?? "unknown" }).pipe(Layer.provide(Layer.succeed(Processors, modules)));
    const server = NodeHttpServer.layer(createServer, { port });
    if (!roles.has("api")) return yield* Layer.launch(HttpRouter.serve(health).pipe(Layer.provide(server)));
    // The admin API (list, pause, resume and reset the processors) exists only when WALLET_ADMIN_TOKEN is set, and is behind that bearer token.
    const adminToken = process.env["WALLET_ADMIN_TOKEN"];
    const admin = adminToken === undefined || adminToken === "" ? Layer.empty : makeWalletAdminApiLayer(modules, Redacted.make(adminToken));
    if (admin !== Layer.empty) yield* Effect.log("admin API mounted at /admin/processors and /admin/events (bearer token from WALLET_ADMIN_TOKEN)");
    yield* Layer.launch(HttpRouter.serve(Layer.mergeAll(makeWalletApiLayer({ basePath: "/api/commands" }), admin, health)).pipe(Layer.provide(server)));
  });

  // Set OTEL_EXPORTER_OTLP_ENDPOINT to export metrics, spans and logs over OTLP (docs/guides/operate/dashboard.md); unset, nothing is exported.
  // The program is scoped, and `runMain` turns SIGINT and SIGTERM into an interrupt: the scope closes, the three processors stop and release their leader locks (another
  // instance takes over at once), and only then does the connection pool close. A failure is logged and ends the process with a non-zero code.
  NodeRuntime.runMain(Effect.provide(Effect.scoped(program), Layer.mergeAll(appLayer, observabilityLayer())));
}

main().catch((error) => {
  console.error("FATAL", error);
  process.exit(1);
});
