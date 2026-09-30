import { createServer } from "node:http";
import { Effect, Layer, Redacted } from "effect";
import { HttpRouter } from "effect/http";
import { NodeHttpServer } from "@effect/platform-node";
import * as Crablet from "@crablet/commands/Crablet";
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

// Entry point: apply migrations, then start the app - views/
// automations/outbox background processors AND the HTTP server, all sharing one connection pool.
async function main(): Promise<void> {
  await migrate(connInfo);

  const appLayer = Crablet.layer({
    host: connInfo.host,
    port: connInfo.port,
    database: connInfo.database,
    username: connInfo.username,
    password: Redacted.make(connInfo.password)
  });

  const program = Effect.gen(function* () {
    yield* startBackgroundProcessors();
    yield* Effect.log(`wallet-example-app listening on :${port}`);
    yield* Layer.launch(
      HttpRouter.serve(makeWalletApiLayer({ basePath: "/api/commands" })).pipe(
        Layer.provide(NodeHttpServer.layer(createServer, { port }))
      )
    );
  });

  await Effect.runPromise(Effect.provide(program, appLayer));
}

main().catch((error) => {
  console.error("FATAL", error);
  process.exit(1);
});
