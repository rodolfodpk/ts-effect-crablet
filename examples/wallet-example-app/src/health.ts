import { createServer, type Server } from "node:http";
import { Duration, Effect, Layer, type Scope } from "effect";
import { HttpRouter, HttpServerResponse } from "effect/http";

// The only HTTP surface of a process that has no `api` role (ADR-0022, decision 5): GET /healthz answers 200 while the process is alive, for a liveness probe. It says nothing about
// leadership, because a standby is healthy. Closed with the scope. Port 0 picks a free port (tests); the address is returned.
// `status`, when given, is also served as JSON on GET /status (what this process runs and leads: see processStatus).
export const serveHealth = (port: number, status?: Effect.Effect<unknown>): Effect.Effect<{ readonly port: number }, Error, Scope.Scope> =>
  Effect.acquireRelease(
    Effect.callback<Server, Error>((resume) => {
      const server = createServer((req, res) => {
        if (req.method === "GET" && req.url === "/healthz") res.writeHead(200, { "content-type": "text/plain" }).end("ok");
        else if (req.method === "GET" && req.url === "/status" && status !== undefined) {
          Effect.runPromise(status).then(
            (body) => res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(body)),
            () => res.writeHead(500).end()
          );
        } else res.writeHead(404).end();
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
export const apiHealthRoutes = (ping: Effect.Effect<unknown, unknown>, timeout: Duration.Input = "2 seconds", status?: Effect.Effect<unknown>) =>
  Layer.mergeAll(
    status === undefined ? Layer.empty : HttpRouter.add("GET", "/status", Effect.map(status, (body) => HttpServerResponse.jsonUnsafe(body))),
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

// What one process says about itself, on GET /status: the roles it runs, and for each module it runs whether it leads it right now. Leadership is in-process state (the advisory lock this
// process holds), which the database cannot tell apart from a lock held by a process that has lost track of it; the chaos lab compares the two.
export interface ModuleStatus { readonly module: "views" | "automations" | "outbox"; readonly runs: boolean; readonly leading: boolean }
export interface ProcessStatus { readonly pod: string; readonly roles: ReadonlyArray<string>; readonly uptimeSeconds: number; readonly modules: ReadonlyArray<ModuleStatus> }
export const processStatus = (
  roles: ReadonlySet<string>,
  leaders: Readonly<Record<ModuleStatus["module"], Effect.Effect<boolean>>>,
  startedAt: number,
  pod: string = process.env["HOSTNAME"] ?? "unknown"
): Effect.Effect<ProcessStatus> =>
  Effect.gen(function* () {
    const modules: ModuleStatus[] = [];
    for (const module of ["views", "automations", "outbox"] as const) modules.push({ module, runs: roles.has(module), leading: roles.has(module) && (yield* leaders[module]) });
    return { pod, roles: [...roles], uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000), modules };
  });
