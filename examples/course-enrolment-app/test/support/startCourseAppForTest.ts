import { createServer } from "node:http";
import { Context, Effect, Exit, Layer, ManagedRuntime, Redacted, Scope } from "effect";
import type { SqlClient } from "effect/sql";
import { HttpRouter, HttpServer } from "effect/http";
import { NodeHttpServer } from "@effect/platform-node";
import * as Crablet from "@crablet/commands/Crablet";
import type { ConnInfo } from "@crablet/test-support";
import { makeCourseApiLayer, type CourseAppConfig } from "../../src/CourseApp.ts";

export interface RunningCourseApp {
  readonly baseUrl: string;
  stop(): Promise<void>;
}

// Starts the API on an ephemeral port against the given test database, for one test file's lifetime.
export const startCourseAppForTest = async (conn: ConnInfo, config: CourseAppConfig = {}): Promise<RunningCourseApp> => {
  const runtime = ManagedRuntime.make(
    Crablet.layer({
      host: conn.host,
      port: conn.port,
      database: conn.database,
      username: conn.username,
      password: Redacted.make(conn.password)
    })
  );
  const scope = await runtime.runPromise(Scope.make());
  const context = await runtime.runPromise(
    Scope.provide(
      Layer.build(
        Layer.provideMerge(HttpRouter.serve(makeCourseApiLayer(config)), NodeHttpServer.layer(createServer, { port: 0 }))
      ) as Effect.Effect<Context.Context<HttpServer.HttpServer>, never, SqlClient.SqlClient>,
      scope
    ) as Effect.Effect<Context.Context<HttpServer.HttpServer>, never, never>
  );
  const server = Context.get(context, HttpServer.HttpServer);
  const port = server.address._tag === "UnixPathAddress" ? 0 : server.address.port;
  return {
    baseUrl: `http://localhost:${port}`,
    stop: async () => {
      await runtime.runPromise(Scope.close(scope, Exit.void));
      await runtime.dispose();
    }
  };
};
