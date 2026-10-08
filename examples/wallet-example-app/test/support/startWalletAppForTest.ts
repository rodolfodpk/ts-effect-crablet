import { createServer } from "node:http";
import { Context, Effect, Exit, Layer, ManagedRuntime, Redacted, Scope } from "effect";
import { SqlClient } from "effect/sql";
import { PgClient } from "@effect/sql-pg";
import { HttpRouter, HttpServer } from "effect/http";
import { NodeHttpServer } from "@effect/platform-node";
import type { EventStore } from "@crablet/eventstore";
import type { CommandAuditStore } from "@crablet/eventstore/CommandAuditStore";
import type { CommandExecutor } from "@crablet/commands";
import type { OutboxPublisher } from "@crablet/outbox/OutboxPublisher";
import { startBackgroundProcessors, stopBackgroundProcessors, makeWalletApiLayer, makeWalletAdminApiLayer, processorSources, type BackgroundProcessors } from "../../src/WalletApp.ts";

export type CoreServices = CommandExecutor | EventStore | CommandAuditStore | SqlClient.SqlClient | PgClient.PgClient;

export interface RunningWalletApp {
  readonly baseUrl: string;
  // The running app's processors, for a test that needs their handles (for example to build a management service over them).
  readonly processors: BackgroundProcessors;
  stop(): Promise<void>;
}

// Starts the whole app (background processors + HTTP server on an ephemeral port) once for a test
// file's lifetime, sharing the given ManagedRuntime's already-built core layers (Postgres
// connection pool, EventStore, CommandExecutor, ...) - same "one long-lived pool across the whole
// file" reasoning views/outbox/automations/commands-http's own integration tests already
// establish. The server's own Scope is created explicitly (not via Effect.scoped) so it can be
// closed on demand in the test file's own `after()` hook, rather than closing the instant the
// starting Effect returns.
export const startWalletAppForTest = async (
  runtime: ManagedRuntime.ManagedRuntime<CoreServices, never>,
  outboxPublishers?: ReadonlyArray<OutboxPublisher>,
  // When given, the admin API is mounted behind this bearer token, as the entry point does with WALLET_ADMIN_TOKEN.
  adminToken?: string
): Promise<RunningWalletApp> => {
  const scope = await runtime.runPromise(Scope.make());

  const { context, processors } = await runtime.runPromise(
    Effect.gen(function* () {
      const processors = yield* startBackgroundProcessors(undefined, outboxPublishers);

      const admin = adminToken === undefined ? Layer.empty : makeWalletAdminApiLayer(yield* processorSources(processors), Redacted.make(adminToken));
      const serverLayer = Layer.provideMerge(
        HttpRouter.serve(Layer.merge(makeWalletApiLayer({ basePath: "/api/commands" }), admin)),
        NodeHttpServer.layer(createServer, { port: 0 })
      );
      const context = yield* Scope.provide(Layer.build(serverLayer), scope);
      return { context, processors };
    })
  );

  const httpServer = Context.get(context, HttpServer.HttpServer);
  const port = httpServer.address._tag === "UnixPathAddress" ? 0 : httpServer.address.port;

  return {
    baseUrl: `http://localhost:${port}`,
    processors,
    // Must stop the background processors' daemon fibers (see stopBackgroundProcessors' own
    // primer) BEFORE closing the scope/disposing the runtime - otherwise they keep polling
    // against a pool that's about to close, spinning forever instead of exiting.
    stop: () =>
      runtime.runPromise(
        Effect.gen(function* () {
          yield* stopBackgroundProcessors(processors);
          yield* Scope.close(scope, Exit.void);
        })
      )
  };
};
