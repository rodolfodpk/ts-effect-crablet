import { createServer } from "node:http";
import { Effect, Layer, Redacted } from "effect";
import { HttpRouter } from "effect/http";
import { NodeHttpServer, NodeRuntime } from "@effect/platform-node";
import * as Crablet from "@crablet/commands/Crablet";
import { migrate } from "./migrate.ts";
import { startBackgroundProcessorsScoped, makeWalletApiLayer } from "./WalletApp.ts";

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
    yield* startBackgroundProcessorsScoped();
    yield* Effect.log(`wallet-example-app listening on :${port}`);
    yield* Layer.launch(
      HttpRouter.serve(makeWalletApiLayer({ basePath: "/api/commands" })).pipe(
        Layer.provide(NodeHttpServer.layer(createServer, { port }))
      )
    );
  });

  // The program is scoped, and `runMain` turns SIGINT and SIGTERM into an interrupt: the scope closes, the three processors stop and release their leader locks (another
  // instance takes over at once), and only then does the connection pool close. A failure is logged and ends the process with a non-zero code.
  NodeRuntime.runMain(Effect.provide(Effect.scoped(program), appLayer));
}

main().catch((error) => {
  console.error("FATAL", error);
  process.exit(1);
});
