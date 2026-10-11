import { createServer, type Server } from "node:http";
import { Duration, Effect, Layer, type Scope } from "effect";
import { HttpRouter, HttpServerResponse } from "effect/http";

// The only HTTP surface of a process that has no `api` role (ADR-0022, decision 5): GET /healthz answers 200 while the process is alive, for a liveness probe. It says nothing about
// leadership, because a standby is healthy. Closed with the scope. Port 0 picks a free port (tests); the address is returned.
export const serveHealth = (port: number): Effect.Effect<{ readonly port: number }, Error, Scope.Scope> =>
  Effect.acquireRelease(
    Effect.callback<Server, Error>((resume) => {
      const server = createServer((req, res) => {
        if (req.method === "GET" && req.url === "/healthz") res.writeHead(200, { "content-type": "text/plain" }).end("ok");
        else res.writeHead(404).end();
      });
      server.once("error", (e) => resume(Effect.fail(e)));
      server.listen(port, () => resume(Effect.succeed(server)));
    }),
    (server) => Effect.callback<void>((resume) => { server.close(() => resume(Effect.void)); server.closeAllConnections(); })
  ).pipe(Effect.map((server) => ({ port: (server.address() as { port: number }).port })));

// The API process's probes, as routes next to the application's own.
//   GET /healthz  liveness: 200 while the process answers. It asks nothing of the database, so a database outage never gets the pod restarted (a restart would not fix it).
//   GET /readyz   readiness: 200 when `ping` (a trivial query) succeeds within `timeout`, 503 when it fails or is too slow, so a pod that cannot reach the database stops receiving traffic.
// The timeout is generous on purpose: a burst that holds every pooled connection for a moment must not take every API pod out of rotation at once (the probe also needs a few failures in a row).
export const apiHealthRoutes = (ping: Effect.Effect<unknown, unknown>, timeout: Duration.Input = "2 seconds") =>
  Layer.mergeAll(
    HttpRouter.add("GET", "/healthz", HttpServerResponse.text("ok")),
    HttpRouter.add(
      "GET",
      "/readyz",
      ping.pipe(
        Effect.timeout(timeout),
        Effect.as(HttpServerResponse.text("ok")),
        Effect.catch(() => Effect.succeed(HttpServerResponse.text("the database did not answer", { status: 503 })))
      )
    )
  );
