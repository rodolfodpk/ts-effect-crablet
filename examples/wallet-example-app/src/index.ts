import { createServer } from "node:http";
import { Effect, Layer, Redacted } from "effect";
import { SqlClient } from "@effect/sql";
import { PgClient } from "@effect/sql-pg";
import { HttpApiBuilder } from "@effect/platform";
import { NodeHttpServer } from "@effect/platform-node";
import { EventStore, EventStoreLive } from "@crablet/eventstore";
import { CommandAuditStore, CommandAuditStoreLive } from "@crablet/eventstore/CommandAuditStore";
import { CommandExecutor, CommandExecutorLive } from "@crablet/commands";
import { migrate } from "./migrate.ts";
import { startBackgroundProcessors, makeWalletApiLayer } from "./WalletApp.ts";

const connInfo = {
  host: process.env["WALLET_DB_HOST"] ?? "localhost",
  port: Number(process.env["WALLET_DB_PORT"] ?? 5432),
  database: process.env["WALLET_DB_NAME"] ?? "wallet_db",
  username: process.env["WALLET_DB_USER"] ?? "postgres",
  password: process.env["WALLET_DB_PASSWORD"] ?? "postgres"
};
const port = Number(process.env["PORT"] ?? 8080);

// Port of WalletApplication.java's entry point: apply migrations, then start the app - views/
// automations/outbox background processors AND the HTTP server, all sharing one connection pool.
async function main(): Promise<void> {
  await migrate(connInfo);

  const pgLayer = PgClient.layer({
    host: connInfo.host,
    port: connInfo.port,
    database: connInfo.database,
    username: connInfo.username,
    password: Redacted.make(connInfo.password)
  });
  const coreLayers = Layer.mergeAll(CommandExecutorLive, EventStoreLive, CommandAuditStoreLive);
  const appLayer = Layer.provideMerge(coreLayers, pgLayer) as unknown as Layer.Layer<
    CommandExecutor | EventStore | CommandAuditStore | SqlClient.SqlClient | PgClient.PgClient,
    never
  >;

  const program = Effect.gen(function* () {
    yield* startBackgroundProcessors();
    yield* Effect.log(`wallet-example-app listening on :${port}`);
    yield* Layer.launch(
      HttpApiBuilder.serve().pipe(
        Layer.provide(makeWalletApiLayer({ basePath: "/api/commands" })),
        Layer.provide(NodeHttpServer.layer(createServer, { port }))
      )
    );
  });

  await Effect.runPromise(Effect.provide(program, appLayer) as Effect.Effect<never, never, never>);
}

main().catch((error) => {
  console.error("FATAL", error);
  process.exit(1);
});
