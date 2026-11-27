import { createServer } from "node:http";
import { Context, Effect, Exit, Layer, ManagedRuntime, Redacted, Scope } from "effect";
import { HttpRouter, HttpServer } from "effect/http";
import { NodeHttpServer } from "@effect/platform-node";
import type { OutboxPublisher } from "@crablet/outbox/OutboxPublisher";
import type { PollingFromConfig as Polling } from "@crablet/app";
import type * as Crablet from "@crablet/app";
import { Processors, type ProcessorsService } from "@crablet/modules/Processors";
import { makeWalletApiLayer, makeWalletAdminApiLayer } from "../../src/WalletApp.ts";
import { walletProcesses } from "../../src/processes.ts";
import { rolesFromValue } from "./roles.ts";

// What the wallet's runtime provides: what Crablet.layer does.
export type CoreServices = Crablet.Services;

export interface RunningWalletApp {
  readonly baseUrl: string;
  // The running app's modules, as the admin API and /status see them (their sources and their status).
  readonly processors: ProcessorsService;
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
  outboxPublisher?: OutboxPublisher,
  // When given, the admin API is mounted behind this bearer token, as the entry point does with WALLET_ADMIN_TOKEN.
  adminToken?: string,
  // The roles this instance runs (ADR-0022); default all, one process. Without `api` no HTTP server starts (baseUrl is ""), and the admin API is only mounted with `api`, as in the entry point.
  options: { readonly roles?: Crablet.Roles<"api">; readonly instanceId?: string; readonly polling?: Polling; readonly leader?: Crablet.LeaderOptions } = {}
): Promise<RunningWalletApp> => {
  const roles = options.roles ?? rolesFromValue("all");
  const runsApi = roles.app.has("api");
  const scope = await runtime.runPromise(Scope.make());

  const { context, processors } = await runtime.runPromise(
    Effect.gen(function* () {
      // In the test's scope, ahead of the server: the scope closes in reverse, so the server stops first, then the processors, both before the pool.
      // a role the test gives that the wallet does not have (UnknownRole) is a defect of the test, not a failure to handle
      const processes = walletProcesses(roles, { instanceId: options.instanceId, outboxPublisher, polling: options.polling, leader: options.leader }).pipe(Layer.orDie);
      const built = yield* Scope.provide(Layer.build(processes), scope);
      const processors = Context.get(built, Processors);
      if (!runsApi) return { context: Context.empty(), processors };

      const admin = adminToken === undefined ? Layer.empty : makeWalletAdminApiLayer(Redacted.make(adminToken));
      const serverLayer = Layer.provideMerge(
        HttpRouter.serve(Layer.merge(makeWalletApiLayer({ basePath: "/api/commands" }), admin)).pipe(Layer.provide(Layer.succeed(Processors, processors))),
        NodeHttpServer.layer(createServer, { port: 0 })
      );
      const context = yield* Scope.provide(Layer.build(serverLayer), scope);
      return { context, processors };
    })
  );

  const port = !runsApi ? 0 : (() => {
    const address = Context.get(context as Context.Context<HttpServer.HttpServer>, HttpServer.HttpServer).address;
    return address._tag === "UnixPathAddress" ? 0 : address.port;
  })();

  return {
    baseUrl: runsApi ? `http://localhost:${port}` : "",
    processors,
    // Closing the scope stops the server and then the background processors, before the caller disposes of the runtime (and its pool).
    stop: () => runtime.runPromise(Scope.close(scope, Exit.void))
  };
};
