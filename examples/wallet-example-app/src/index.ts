import { createServer } from "node:http";
import { Effect, Layer, Redacted } from "effect";
import { HttpRouter } from "effect/http";
import { NodeHttpServer, NodeRuntime } from "@effect/platform-node";
import * as Crablet from "@crablet/commands/Crablet";
import { monitorStorage } from "@crablet/eventstore/Storage";
import { migrateIfFresh } from "./migrate.ts";
import { startBackgroundProcessorsScoped, monitorBackgroundProcessors, processorSources, makeWalletAdminApiLayer, makeWalletApiLayer } from "./WalletApp.ts";
import { observabilityLayer } from "./Observability.ts";
import { poolSizeFromEnv } from "./poolSize.ts";

const connInfo = {
  host: process.env["WALLET_DB_HOST"] ?? "localhost",
  port: Number(process.env["WALLET_DB_PORT"] ?? 5432),
  database: process.env["WALLET_DB_NAME"] ?? "wallet_db",
  username: process.env["WALLET_DB_USER"] ?? "postgres",
  password: process.env["WALLET_DB_PASSWORD"] ?? "postgres"
};
const port = Number(process.env["PORT"] ?? 8080);
const poolSize = poolSizeFromEnv();

// Entry point: apply migrations (to a fresh database only), then start the app - views/
// automations/outbox background processors AND the HTTP server, all sharing one connection pool.
async function main(): Promise<void> {
  console.log(`migrations: ${(await migrateIfFresh(connInfo)) === "applied" ? "applied to a fresh database" : "the schema is already there, left as it is"}`);

  const appLayer = Crablet.layer({
    host: connInfo.host,
    port: connInfo.port,
    database: connInfo.database,
    username: connInfo.username,
    password: Redacted.make(connInfo.password),
    // WALLET_DB_POOL: at most this many connections. Unset, the library's default applies.
    ...(poolSize === undefined ? {} : { maxConnections: poolSize })
  });

  const program = Effect.gen(function* () {
    const processors = yield* startBackgroundProcessorsScoped();
    yield* monitorBackgroundProcessors(processors);
    yield* Effect.forkScoped(monitorStorage({ every: "1 minute" })); // the crablet.storage.* gauges
    yield* Effect.log(`wallet-example-app listening on :${port}; database pool: ${poolSize === undefined ? "the library's default size" : `up to ${poolSize} connections`}`);
    // The admin API (list, pause, resume and reset the processors) exists only when WALLET_ADMIN_TOKEN is set, and is behind that bearer token.
    const adminToken = process.env["WALLET_ADMIN_TOKEN"];
    const admin = adminToken === undefined || adminToken === "" ? Layer.empty : makeWalletAdminApiLayer(yield* processorSources(processors), Redacted.make(adminToken));
    if (admin !== Layer.empty) yield* Effect.log("admin API mounted at /admin/processors (bearer token from WALLET_ADMIN_TOKEN)");
    yield* Layer.launch(
      HttpRouter.serve(Layer.merge(makeWalletApiLayer({ basePath: "/api/commands" }), admin)).pipe(
        Layer.provide(NodeHttpServer.layer(createServer, { port }))
      )
    );
  });

  // Set OTEL_EXPORTER_OTLP_ENDPOINT to export metrics, spans and logs over OTLP (docs/guides/dashboard.md); unset, nothing is exported.
  // The program is scoped, and `runMain` turns SIGINT and SIGTERM into an interrupt: the scope closes, the three processors stop and release their leader locks (another
  // instance takes over at once), and only then does the connection pool close. A failure is logged and ends the process with a non-zero code.
  NodeRuntime.runMain(Effect.provide(Effect.scoped(program), Layer.mergeAll(appLayer, observabilityLayer())));
}

main().catch((error) => {
  console.error("FATAL", error);
  process.exit(1);
});
