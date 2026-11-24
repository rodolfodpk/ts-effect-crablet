import { Clock, Duration, Effect, Layer } from "effect";
import { HttpRouter, HttpServerResponse } from "effect/http";
import { Processors, type ModuleStatus } from "@crablet/modules/Processors";

export interface HealthOptions {
  // A trivial query (`sql\`SELECT 1\``): what /readyz asks before saying the process can take traffic.
  readonly ping: Effect.Effect<unknown, unknown>;
  // How long /readyz waits for the ping. Generous on purpose (default 2 seconds): a burst that holds every pooled connection for a moment must not take
  // every pod out of rotation at once.
  readonly readyTimeout?: Duration.Input | undefined;
  // The name /status gives this process (the pod's name, the instance id). Left out of the answer when not given.
  readonly instance?: string | undefined;
}

// What one process says about itself on GET /status.
export interface ProcessReport {
  readonly instance?: string;
  readonly uptimeSeconds: number;
  readonly modules: ReadonlyArray<ModuleStatus>;
}

// A process's probes, as routes to serve next to its others, on the server the application provides (no server here, as with `serveApi`, ADR-0042):
//   GET /healthz  liveness: 200 while the process answers. It asks nothing of the database or of the modules, so neither a database outage nor a lost
//                 leadership gets the pod restarted (a restart would fix neither). A standby is healthy (ADR-0022).
//   GET /readyz   readiness: 200 when `ping` answers within `readyTimeout`, 503 when it fails, dies or is too slow, so a pod that cannot reach the database
//                 stops receiving traffic. Leadership plays no part.
//   GET /status   JSON (ProcessReport): for each module of the process, whether it runs it here and whether it leads it now. Leadership is in-process
//                 state (the lock this process holds), which is why each process is asked.
// `Processors` (`Crablet.processors` or `Crablet.catalog` in @crablet/app) is read when the layer is built; uptime counts from then.
export const healthRoutes = (options: HealthOptions) =>
  Layer.unwrap(
    Effect.gen(function* () {
      const { status } = yield* Processors;
      const startedAt = yield* Clock.currentTimeMillis;
      const report = Effect.gen(function* () {
        const modules = yield* status;
        const uptimeSeconds = Math.floor(((yield* Clock.currentTimeMillis) - startedAt) / 1000);
        const answer: ProcessReport = options.instance === undefined ? { uptimeSeconds, modules } : { instance: options.instance, uptimeSeconds, modules };
        return HttpServerResponse.jsonUnsafe(answer);
      });
      const notReady = HttpServerResponse.text("the database did not answer", { status: 503 });
      return Layer.mergeAll(
        HttpRouter.add("GET", "/healthz", HttpServerResponse.text("ok")),
        HttpRouter.add(
          "GET",
          "/readyz",
          options.ping.pipe(
            Effect.timeout(options.readyTimeout ?? "2 seconds"),
            Effect.as(HttpServerResponse.text("ok")),
            // A failure or a defect of the ping is "not ready"; an interruption (the client went away) stays one.
            Effect.catch(() => Effect.succeed(notReady)),
            Effect.catchDefect(() => Effect.succeed(notReady))
          )
        ),
        HttpRouter.add("GET", "/status", report)
      );
    })
  );
