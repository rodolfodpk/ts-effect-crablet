import { createServer, type Server } from "node:http";
import { Effect, type Scope } from "effect";

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
